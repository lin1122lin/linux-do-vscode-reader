import * as vscode from "vscode";
import sanitizeHtml from "sanitize-html";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
import WebSocket from "ws";

const BASE_URL = "https://linux.do";
const COOKIE_KEY = "linuxDoReader.sessionCookie";
const BROWSER_READY_KEY = "linuxDoReader.browserReady";
let globalDisguised = false;

interface TopicSummary {
  id: number;
  title: string;
  fancy_title?: string;
  slug: string;
  posts_count: number;
  reply_count?: number;
  views: number;
  like_count?: number;
  last_posted_at: string;
  pinned?: boolean;
  closed?: boolean;
  tags?: string[];
}

interface Post {
  id: number;
  username: string;
  name?: string;
  avatar_template?: string;
  created_at: string;
  cooked: string;
  post_number: number;
  reads?: number;
  reply_count?: number;
  reply_to_post_number?: number | null;
  reply_to_user?: {
    username: string;
    name?: string;
  };
  actions_summary?: Array<{
    id: number;
    count?: number;
    acted?: boolean;
    can_act?: boolean;
  }>;
}

interface TopicDetail {
  id: number;
  title: string;
  fancy_title?: string;
  slug: string;
  posts_count: number;
  post_stream: {
    posts: Post[];
    stream: number[];
  };
  details?: {
    can_create_post?: boolean;
  };
}

interface CreatePostResponse extends Partial<Post> {
  post?: Post;
  action?: string;
  success?: boolean;
}

interface Category {
  id: number;
  name: string;
  slug: string;
  color?: string;
  topic_count?: number;
}

interface TopicsPage {
  topics: TopicSummary[];
  hasMore: boolean;
}

class LinuxDoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface BrowserFetchResult {
  status: number;
  contentType: string;
  body: string;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class CdpConnection implements vscode.Disposable {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Chrome DevTools 命令失败"));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.on("close", () => this.rejectAll(new Error("Chrome 调试连接已关闭")));
    socket.on("error", (error) => this.rejectAll(error));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(url);
      candidate.once("open", () => resolve(candidate));
      candidate.once("error", reject);
    });
    return new CdpConnection(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome 调试连接不可用");
    }
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  dispose(): void {
    this.socket.close();
    this.rejectAll(new Error("Chrome 调试连接已释放"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class BrowserSession implements vscode.Disposable {
  private chromeProcess?: ChildProcess;
  private connection?: CdpConnection;
  private targetId?: string;
  private port?: number;
  private starting?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isReady(): Promise<boolean> {
    return this.context.globalState.get<boolean>(BROWSER_READY_KEY, false);
  }

  async connectInteractive(): Promise<boolean> {
    await this.ensureRunning(true);
    await this.navigateHome();
    await this.showWindow();
    const choice = await vscode.window.showInformationMessage(
      "请在弹出的专用 Chrome 窗口中登录 Linux.do，并完成可能出现的 Cloudflare 验证。",
      { modal: true },
      "我已完成登录"
    );
    if (choice !== "我已完成登录") {
      return false;
    }
    try {
      const payload = await this.request<{ current_user?: { username?: string } }>(
        "/session/current.json",
        true
      );
      if (!payload.current_user?.username) {
        throw new LinuxDoError("Chrome 中尚未登录 Linux.do，请完成登录后重试。", 401);
      }
      await this.context.globalState.update(BROWSER_READY_KEY, true);
      void vscode.window.showInformationMessage(
        `已连接 Linux.do：@${payload.current_user.username}`
      );
      return true;
    } catch (error) {
      await this.context.globalState.update(BROWSER_READY_KEY, false);
      void showRequestError(error);
      return false;
    }
  }

  async request<T>(pathName: string, skipReadyCheck = false): Promise<T> {
    if (!skipReadyCheck && !(await this.isReady())) {
      throw new LinuxDoError("尚未连接专用 Chrome，请先完成一次浏览器登录。", 428);
    }
    await this.ensureRunning(false);
    await this.ensureLinuxDoPage();

    const expression = `(async () => {
      const response = await fetch(new URL(${JSON.stringify(pathName)}, location.origin), {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        body: await response.text()
      };
    })()`;
    return this.evaluateJson<T>(expression);
  }

  async mutate<T>(
    pathName: string,
    method: "POST" | "DELETE",
    body: Record<string, unknown>
  ): Promise<T> {
    if (!(await this.isReady())) {
      throw new LinuxDoError("尚未连接专用 Chrome，请先完成一次浏览器登录。", 428);
    }
    await this.ensureRunning(false);
    await this.ensureLinuxDoPage();

    const expression = `(async () => {
      const csrfResponse = await fetch(new URL("/session/csrf.json", location.origin), {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      if (!csrfResponse.ok) {
        return {
          status: csrfResponse.status,
          contentType: csrfResponse.headers.get("content-type") || "",
          body: await csrfResponse.text()
        };
      }
      const csrfPayload = await csrfResponse.json();
      const response = await fetch(new URL(${JSON.stringify(pathName)}, location.origin), {
        method: ${JSON.stringify(method)},
        credentials: "include",
        redirect: "manual",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfPayload.csrf,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(${JSON.stringify(body)})
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        body: await response.text()
      };
    })()`;
    return this.evaluateJson<T>(expression);
  }

  private async evaluateJson<T>(expression: string): Promise<T> {
    const evaluation = await this.connection!.send<{
      result?: { value?: BrowserFetchResult; description?: string };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    });
    if (evaluation.exceptionDetails || !evaluation.result?.value) {
      throw new LinuxDoError(
        `Chrome 请求执行失败：${
          evaluation.exceptionDetails?.text ||
          evaluation.result?.description ||
          "未知浏览器错误"
        }`
      );
    }
    const response = evaluation.result.value;
    if (response.status === 401) {
      await this.context.globalState.update(BROWSER_READY_KEY, false);
      throw new LinuxDoError("Linux.do 登录已失效，请重新连接 Chrome。", 401);
    }
    if (!response.contentType.includes("json")) {
      await this.context.globalState.update(BROWSER_READY_KEY, false);
      throw new LinuxDoError(
        "Chrome 会话需要重新完成 Cloudflare 验证，请打开专用 Chrome。",
        403
      );
    }
    if (response.status < 200 || response.status >= 300) {
      let detail = "";
      try {
        const payload = JSON.parse(response.body) as {
          errors?: string[];
          error?: string;
          message?: string;
        };
        detail = payload.errors?.join("；") || payload.error || payload.message || "";
      } catch {
        // Keep the generic status message when the server did not return JSON.
      }
      throw new LinuxDoError(
        detail || `Linux.do 请求失败（HTTP ${response.status}）。`,
        response.status
      );
    }
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new LinuxDoError("Linux.do 返回了无法解析的数据。");
    }
  }

  async resetProfile(): Promise<void> {
    await this.context.globalState.update(BROWSER_READY_KEY, false);
    this.dispose();
  }

  dispose(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.targetId = undefined;
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill();
    }
    this.chromeProcess = undefined;
  }

  private async ensureRunning(interactive: boolean): Promise<void> {
    if (this.connection) {
      if (interactive) {
        await this.showWindow();
      }
      return;
    }
    if (this.starting) {
      await this.starting;
      if (interactive) {
        await this.showWindow();
      }
      return;
    }
    this.starting = this.startChrome(interactive);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startChrome(interactive: boolean): Promise<void> {
    const executable = findChromeExecutable();
    if (!executable) {
      throw new LinuxDoError(
        "未找到 Chrome 或 Edge，请在设置中填写 linuxDoReader.chromePath。"
      );
    }
    const profilePath = path.join(this.context.globalStorageUri.fsPath, "chrome-profile");
    await mkdir(profilePath, { recursive: true });
    this.port = await availablePort();
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      interactive ? "--new-window" : "--start-minimized",
      BASE_URL
    ];
    const proxy = configuredProxy();
    if (proxy) {
      args.splice(args.length - 1, 0, `--proxy-server=${proxy}`);
    }
    this.chromeProcess = spawn(executable, args, {
      stdio: "ignore",
      windowsHide: true
    });
    this.chromeProcess.once("exit", () => {
      this.connection?.dispose();
      this.connection = undefined;
      this.chromeProcess = undefined;
      this.targetId = undefined;
    });

    const targets = await waitForTargets(this.port);
    const target =
      targets.find((item) => item.type === "page" && item.url.startsWith(BASE_URL)) ??
      targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) {
      throw new LinuxDoError("Chrome 已启动，但未找到可控制的页面。");
    }
    this.targetId = target.id;
    this.connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await this.connection.send("Page.enable");
    await this.connection.send("Runtime.enable");
    if (!target.url.startsWith(BASE_URL)) {
      await this.navigateHome();
    }
    if (interactive) {
      await this.showWindow();
    }
  }

  private async ensureLinuxDoPage(): Promise<void> {
    const result = await this.connection!.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      {
        expression: "location.origin",
        returnByValue: true
      }
    );
    if (result.result?.value !== BASE_URL) {
      await this.navigateHome();
    }
  }

  private async navigateHome(): Promise<void> {
    await this.connection!.send("Page.navigate", { url: BASE_URL });
    await delay(1800);
  }

  private async showWindow(): Promise<void> {
    if (!this.connection || !this.targetId) {
      return;
    }
    await this.connection.send("Page.bringToFront");
    try {
      const window = await this.connection.send<{ windowId: number }>(
        "Browser.getWindowForTarget",
        { targetId: this.targetId }
      );
      await this.connection.send("Browser.setWindowBounds", {
        windowId: window.windowId,
        bounds: { windowState: "normal" }
      });
    } catch {
      // Some Chromium builds do not expose window management on a page target.
    }
  }
}

class LinuxDoClient implements vscode.Disposable {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly browser: BrowserSession
  ) {}

  dispose(): void {
    // BrowserSession owns the underlying browser lifecycle.
  }

  async hasCookie(): Promise<boolean> {
    return this.browser.isReady();
  }

  async saveCookie(cookie: string): Promise<void> {
    await this.secrets.store(COOKIE_KEY, normalizeCookie(cookie));
  }

  async clearCookie(): Promise<void> {
    await this.secrets.delete(COOKIE_KEY);
  }

  async validateCookie(cookie: string): Promise<void> {
    await this.request("/session/current.json", normalizeCookie(cookie));
  }

  async getLatest(page = 0): Promise<TopicsPage> {
    const payload = await this.request<{
      topic_list?: { topics?: TopicSummary[]; more_topics_url?: string };
    }>(
      `/latest.json?no_definitions=true&page=${page}`
    );
    return topicsPage(payload);
  }

  async getHot(page = 0): Promise<TopicsPage> {
    const payload = await this.request<{
      topic_list?: { topics?: TopicSummary[]; more_topics_url?: string };
    }>(
      `/top.json?period=daily&page=${page}`
    );
    return topicsPage(payload);
  }

  async getCategoryLatest(category: Category, page = 0): Promise<TopicsPage> {
    const payload = await this.request<{
      topic_list?: { topics?: TopicSummary[]; more_topics_url?: string };
    }>(`/c/${encodeURIComponent(category.slug)}/${category.id}/l/latest.json?page=${page}`);
    return topicsPage(payload);
  }

  async getCategories(): Promise<Category[]> {
    const payload = await this.request<{ category_list?: { categories?: Category[] } }>(
      "/categories.json"
    );
    return payload.category_list?.categories ?? [];
  }

  async search(query: string, page = 0): Promise<TopicsPage> {
    const payload = await this.request<{
      topics?: TopicSummary[];
      grouped_search_result?: {
        topic_ids?: number[];
        more_full_page_results?: boolean;
      };
    }>(`/search.json?q=${encodeURIComponent(query)}&page=${page}`);
    const topics = payload.topics ?? [];
    const order = payload.grouped_search_result?.topic_ids;
    if (!order?.length) {
      return {
        topics,
        hasMore: Boolean(payload.grouped_search_result?.more_full_page_results)
      };
    }
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    return {
      topics: order
        .map((id) => byId.get(id))
        .filter((topic): topic is TopicSummary => Boolean(topic)),
      hasMore: Boolean(payload.grouped_search_result?.more_full_page_results)
    };
  }

  async getTopic(topicId: number): Promise<TopicDetail> {
    return this.request<TopicDetail>(`/t/${topicId}.json`);
  }

  async getPosts(topicId: number, postIds: number[]): Promise<Post[]> {
    const query = postIds.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join("&");
    const payload = await this.request<{ post_stream?: { posts?: Post[] } }>(
      `/t/${topicId}/posts.json?${query}`
    );
    return payload.post_stream?.posts ?? [];
  }

  async createReply(
    topicId: number,
    raw: string,
    replyToPostNumber?: number
  ): Promise<CreatePostResponse> {
    return this.browser.mutate<CreatePostResponse>("/posts.json", "POST", {
      topic_id: topicId,
      raw,
      ...(replyToPostNumber ? { reply_to_post_number: replyToPostNumber } : {})
    });
  }

  async likePost(postId: number): Promise<Post> {
    return this.browser.mutate<Post>("/post_actions.json", "POST", {
      id: postId,
      post_action_type_id: 2,
      flag_topic: false
    });
  }

  async unlikePost(postId: number): Promise<Post> {
    return this.browser.mutate<Post>(`/post_actions/${postId}.json`, "DELETE", {
      post_action_type_id: 2
    });
  }

  private async request<T>(path: string, cookieOverride?: string): Promise<T> {
    if (cookieOverride) {
      throw new LinuxDoError("0.3.0 起不再使用复制 Cookie，请连接专用 Chrome。");
    }
    return this.browser.request<T>(path);
  }
}

type TopicMode = "latest" | "hot" | "search";

class TopicItem extends vscode.TreeItem {
  constructor(readonly topic: TopicSummary) {
    super(decodeEntities(topic.fancy_title || topic.title), vscode.TreeItemCollapsibleState.None);
    const replies = Math.max(0, (topic.posts_count ?? 1) - 1);
    this.description = `${replies} 回复 · ${formatCount(topic.views)} 浏览`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${escapeMarkdown(decodeEntities(topic.fancy_title || topic.title))}**`,
        "",
        `${replies} 回复 · ${topic.views ?? 0} 浏览 · ${topic.like_count ?? 0} 赞`,
        "",
        `最近活跃：${formatDate(topic.last_posted_at)}`,
        topic.tags?.length ? `标签：${topic.tags.join("、")}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
    this.iconPath = new vscode.ThemeIcon(
      topic.pinned ? "pinned" : topic.closed ? "lock" : "comment-discussion"
    );
    this.command = {
      command: "linuxDoReader.openTopic",
      title: "阅读话题",
      arguments: [topic]
    };
    this.contextValue = "linuxDoTopic";
  }
}

class LoadMoreItem extends vscode.TreeItem {
  constructor() {
    super("继续加载更多话题…", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("fold-down");
    this.command = {
      command: "linuxDoReader.loadMoreTopics",
      title: "继续加载更多话题"
    };
    this.contextValue = "linuxDoLoadMore";
  }
}

class TopicsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private topics: TopicSummary[] | undefined;
  private mode: TopicMode = "latest";
  private query = "";
  private category?: Category;
  private nextPage = 0;
  private hasMore = false;
  private loading = false;

  constructor(private readonly client: LinuxDoClient) {}

  async refresh(): Promise<void> {
    this.topics = undefined;
    this.nextPage = 0;
    this.hasMore = false;
    this.changed.fire();
  }

  async showLatest(): Promise<void> {
    this.mode = "latest";
    this.query = "";
    this.category = undefined;
    await this.refresh();
  }

  async showHot(): Promise<void> {
    this.mode = "hot";
    this.query = "";
    this.category = undefined;
    await this.refresh();
  }

  async showSearch(query: string): Promise<void> {
    this.mode = "search";
    this.query = query;
    this.category = undefined;
    await this.refresh();
  }

  async showCategory(category: Category | undefined): Promise<void> {
    this.mode = "latest";
    this.query = "";
    this.category = category;
    await this.refresh();
  }

  get label(): string {
    if (this.category) {
      return this.category.name;
    }
    if (this.mode === "search") {
      return `搜索：${this.query}`;
    }
    return this.mode === "hot" ? "每日热门" : "最新";
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    if (!(await this.client.hasCookie())) {
      return [];
    }
    if (!this.topics) {
      try {
        await this.fetchNextPage();
      } catch (error) {
        void showRequestError(error);
        return [];
      }
    }
    const items: vscode.TreeItem[] = (this.topics ?? []).map((topic) => new TopicItem(topic));
    if (this.hasMore) {
      items.push(new LoadMoreItem());
    }
    return items;
  }

  async loadMore(): Promise<void> {
    if (this.loading || !this.hasMore) {
      return;
    }
    try {
      await this.fetchNextPage();
      this.changed.fire();
    } catch (error) {
      void showRequestError(error);
    }
  }

  private async fetchNextPage(): Promise<void> {
    this.loading = true;
    try {
      const page = this.category
        ? await this.client.getCategoryLatest(this.category, this.nextPage)
        : this.mode === "latest"
          ? await this.client.getLatest(this.nextPage)
          : this.mode === "hot"
            ? await this.client.getHot(this.nextPage)
            : await this.client.search(this.query, this.nextPage);
      const currentIds = new Set((this.topics ?? []).map((topic) => topic.id));
      const additions = page.topics.filter((topic) => !currentIds.has(topic.id));
      this.topics = [...(this.topics ?? []), ...additions];
      this.hasMore = page.hasMore && additions.length > 0;
      this.nextPage += 1;
    } finally {
      this.loading = false;
    }
  }
}

class TopicPanel {
  private static readonly panels = new Map<number, TopicPanel>();
  private static active?: TopicPanel;
  private readonly panel: vscode.WebviewPanel;
  private detail?: TopicDetail;
  private loadedPostIds = new Set<number>();
  private loading = false;
  private replying = false;
  private readonly interactingPostIds = new Set<number>();
  private disguised: boolean;

  static async show(client: LinuxDoClient, topic: TopicSummary): Promise<void> {
    const existing = TopicPanel.panels.get(topic.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "linuxDoReader.topic",
      decodeEntities(topic.fancy_title || topic.title),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableCommandUris: false
      }
    );
    const instance = new TopicPanel(client, panel, topic);
    TopicPanel.panels.set(topic.id, instance);
    TopicPanel.active = instance;
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TopicPanel.active = instance;
      }
    });
    panel.onDidDispose(() => {
      TopicPanel.panels.delete(topic.id);
      if (TopicPanel.active === instance) {
        TopicPanel.active = undefined;
      }
    });
    await instance.load();
  }

  static async toggleActiveDisguise(): Promise<boolean> {
    if (!TopicPanel.active?.panel.active) {
      return false;
    }
    await TopicPanel.active.toggleDisguise();
    return true;
  }

  static async setAllDisguised(value: boolean): Promise<number> {
    const panels = [...TopicPanel.panels.values()];
    await Promise.all(panels.map((panel) => panel.setDisguised(value)));
    return panels.length;
  }

  private constructor(
    private readonly client: LinuxDoClient,
    panel: vscode.WebviewPanel,
    private readonly topic: TopicSummary
  ) {
    this.panel = panel;
    this.disguised =
      globalDisguised ||
      vscode.workspace
        .getConfiguration("linuxDoReader")
        .get<boolean>("disguiseOnOpen", false);
    this.panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
  }

  private async load(): Promise<void> {
    this.panel.webview.html = loadingHtml(this.panel.webview, this.topic.title);
    try {
      this.detail = await this.client.getTopic(this.topic.id);
      for (const post of this.detail.post_stream.posts) {
        this.loadedPostIds.add(post.id);
      }
      this.panel.webview.html = topicHtml(
        this.panel.webview,
        this.detail,
        this.detail.post_stream.posts,
        this.hasMorePosts(),
        this.disguised
      );
      this.updatePanelTitle();
    } catch (error) {
      this.panel.webview.html = errorHtml(this.panel.webview, toMessage(error));
      void showRequestError(error);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const value = message as {
      type?: string;
      href?: string;
      postId?: number;
      postNumber?: number;
      liked?: boolean;
      count?: number;
      raw?: string;
      replyToPostNumber?: number;
    };
    if (value.type === "openLink" && value.href) {
      const uri = safeExternalUri(value.href);
      if (uri) {
        await vscode.env.openExternal(uri);
      }
      return;
    }
    if (value.type === "openOriginal") {
      await vscode.env.openExternal(vscode.Uri.parse(`${BASE_URL}/t/${this.topic.slug}/${this.topic.id}`));
      return;
    }
    if (value.type === "toggleDisguise") {
      await vscode.commands.executeCommand("linuxDoReader.toggleDisguise");
      return;
    }
    if (value.type === "openSettings") {
      SettingsPanel.show();
      return;
    }
    if (value.type === "loadMore") {
      await this.loadMore();
      return;
    }
    if (
      value.type === "toggleLike" &&
      typeof value.postId === "number" &&
      typeof value.liked === "boolean"
    ) {
      await this.toggleLike(value.postId, value.liked, value.count ?? 0);
      return;
    }
    if (value.type === "submitReply" && typeof value.raw === "string") {
      await this.submitReply(value.raw, value.replyToPostNumber);
    }
  }

  private async toggleLike(postId: number, liked: boolean, count: number): Promise<void> {
    if (
      !vscode.workspace
        .getConfiguration("linuxDoReader")
        .get<boolean>("enableInteractions", true) ||
      this.interactingPostIds.has(postId)
    ) {
      return;
    }
    this.interactingPostIds.add(postId);
    await this.panel.webview.postMessage({ type: "likeBusy", postId, value: true });
    try {
      const post = liked
        ? await this.client.unlikePost(postId)
        : await this.client.likePost(postId);
      const action = post.actions_summary?.find((item) => item.id === 2);
      await this.panel.webview.postMessage({
        type: "likeUpdated",
        postId,
        liked: action?.acted ?? !liked,
        count: action?.count ?? Math.max(0, count + (liked ? -1 : 1))
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: "actionError",
        postId,
        message: toMessage(error)
      });
    } finally {
      this.interactingPostIds.delete(postId);
      await this.panel.webview.postMessage({ type: "likeBusy", postId, value: false });
    }
  }

  private async submitReply(rawValue: string, replyToPostNumber?: number): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("linuxDoReader");
    if (!configuration.get<boolean>("enableInteractions", true) || this.replying) {
      return;
    }
    const raw = rawValue.trim();
    if (!raw) {
      await this.panel.webview.postMessage({
        type: "replyError",
        message: "回复内容不能为空。"
      });
      return;
    }
    if (configuration.get<boolean>("confirmBeforeReply", true)) {
      const choice = await vscode.window.showWarningMessage(
        replyToPostNumber
          ? `确认发布对 #${replyToPostNumber} 的回复？`
          : "确认将这段内容回复到当前话题？",
        { modal: true },
        "确认发布"
      );
      if (choice !== "确认发布") {
        return;
      }
    }

    this.replying = true;
    await this.panel.webview.postMessage({ type: "replyBusy", value: true });
    try {
      const response = await this.client.createReply(
        this.topic.id,
        raw,
        typeof replyToPostNumber === "number" ? replyToPostNumber : undefined
      );
      const created =
        response.post ??
        (typeof response.id === "number" &&
        typeof response.post_number === "number" &&
        typeof response.cooked === "string"
          ? (response as Post)
          : undefined);
      if (created) {
        this.loadedPostIds.add(created.id);
        this.detail?.post_stream.stream.push(created.id);
        if (this.detail) {
          this.detail.posts_count = Math.max(this.detail.posts_count + 1, created.post_number);
        }
        await this.panel.webview.postMessage({
          type: "replyCreated",
          html: postHtml(created),
          postNumber: created.post_number
        });
      } else {
        await this.panel.webview.postMessage({
          type: "replySubmitted",
          message:
            response.action === "enqueued"
              ? "回复已提交，正在等待站点审核。"
              : "回复已提交。"
        });
      }
    } catch (error) {
      await this.panel.webview.postMessage({
        type: "replyError",
        message: toMessage(error)
      });
    } finally {
      this.replying = false;
      await this.panel.webview.postMessage({ type: "replyBusy", value: false });
    }
  }

  private async loadMore(): Promise<void> {
    if (!this.detail || this.loading) {
      return;
    }
    const ids = this.detail.post_stream.stream
      .filter((id) => !this.loadedPostIds.has(id))
      .slice(0, 20);
    if (!ids.length) {
      return;
    }

    this.loading = true;
    await this.panel.webview.postMessage({ type: "loading", value: true });
    try {
      const posts = await this.client.getPosts(this.topic.id, ids);
      posts.sort((a, b) => a.post_number - b.post_number);
      for (const post of posts) {
        this.loadedPostIds.add(post.id);
      }
      await this.panel.webview.postMessage({
        type: "appendPosts",
        html: posts.map(postHtml).join(""),
        hasMore: this.hasMorePosts()
      });
    } catch (error) {
      await this.panel.webview.postMessage({ type: "loadError", message: toMessage(error) });
    } finally {
      this.loading = false;
      await this.panel.webview.postMessage({ type: "loading", value: false });
    }
  }

  private hasMorePosts(): boolean {
    return Boolean(this.detail?.post_stream.stream.some((id) => !this.loadedPostIds.has(id)));
  }

  private async toggleDisguise(): Promise<void> {
    await this.setDisguised(!this.disguised);
  }

  private async setDisguised(value: boolean): Promise<void> {
    if (this.disguised === value) {
      return;
    }
    this.disguised = value;
    this.updatePanelTitle();
    await this.panel.webview.postMessage({
      type: "disguise",
      value: this.disguised
    });
  }

  private updatePanelTitle(): void {
    this.panel.title = this.disguised
      ? vscode.workspace
          .getConfiguration("linuxDoReader")
          .get<string>("disguiseFileName", "workspace-utils.ts")
      : decodeEntities(this.topic.fancy_title || this.topic.title);
  }
}

class TopicsPagePanel {
  private static instance?: TopicsPagePanel;
  private readonly panel: vscode.WebviewPanel;
  private mode: TopicMode = "latest";
  private query = "";
  private category?: Category;
  private categories: Category[] = [];
  private topics = new Map<number, TopicSummary>();
  private nextPage = 0;
  private hasMore = true;
  private loading = false;
  private initialized = false;
  private disguised: boolean;

  static async show(
    client: LinuxDoClient,
    browser: BrowserSession,
    mode: TopicMode = "latest",
    query = ""
  ): Promise<void> {
    if (TopicsPagePanel.instance) {
      TopicsPagePanel.instance.panel.reveal(vscode.ViewColumn.One);
      if (mode !== TopicsPagePanel.instance.mode || query !== TopicsPagePanel.instance.query) {
        await TopicsPagePanel.instance.setMode(mode, query);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "linuxDoReader.topicsPage",
      "Linux.do · 话题广场",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableCommandUris: false
      }
    );
    const instance = new TopicsPagePanel(client, browser, panel, mode, query);
    TopicsPagePanel.instance = instance;
    panel.onDidDispose(() => {
      TopicsPagePanel.instance = undefined;
    });
  }

  static async reload(): Promise<void> {
    if (TopicsPagePanel.instance?.initialized) {
      await TopicsPagePanel.instance.resetAndLoad();
    }
  }

  static async toggleActiveDisguise(): Promise<boolean> {
    if (!TopicsPagePanel.instance?.panel.active) {
      return false;
    }
    await TopicsPagePanel.instance.toggleDisguise();
    return true;
  }

  static async setAllDisguised(value: boolean): Promise<number> {
    if (!TopicsPagePanel.instance) {
      return 0;
    }
    await TopicsPagePanel.instance.setDisguised(value);
    return 1;
  }

  private constructor(
    private readonly client: LinuxDoClient,
    private readonly browser: BrowserSession,
    panel: vscode.WebviewPanel,
    mode: TopicMode,
    query: string
  ) {
    this.panel = panel;
    this.mode = mode;
    this.query = query;
    this.disguised =
      globalDisguised ||
      vscode.workspace
        .getConfiguration("linuxDoReader")
        .get<boolean>("disguiseOnOpen", false);
    this.panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    this.panel.webview.html = topicsPageHtml(this.panel.webview, this.disguised);
    this.updatePanelTitle();
  }

  private async initialize(): Promise<void> {
    await this.resetAndLoad();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const value = message as {
      type?: string;
      mode?: TopicMode;
      query?: string;
      categoryId?: number | null;
      topicId?: number;
    };
    if (value.type === "ready" && !this.initialized) {
      this.initialized = true;
      await this.initialize();
    } else if (value.type === "loadMore" && this.initialized) {
      await this.loadNextPage();
    } else if (value.type === "mode" && (value.mode === "latest" || value.mode === "hot")) {
      await this.setMode(value.mode);
    } else if (value.type === "search" && typeof value.query === "string") {
      await this.setMode("search", value.query.trim());
    } else if (value.type === "category") {
      this.category =
        typeof value.categoryId === "number"
          ? this.categories.find((category) => category.id === value.categoryId)
          : undefined;
      this.mode = "latest";
      this.query = "";
      await this.resetAndLoad(false);
    } else if (value.type === "openTopic" && typeof value.topicId === "number") {
      const topic = this.topics.get(value.topicId);
      if (topic) {
        await TopicPanel.show(this.client, topic);
      }
    } else if (value.type === "connectBrowser") {
      if (await this.browser.connectInteractive()) {
        await this.resetAndLoad();
      }
    } else if (value.type === "settings") {
      SettingsPanel.show();
    } else if (value.type === "toggleDisguise") {
      await vscode.commands.executeCommand("linuxDoReader.toggleDisguise");
    }
  }

  private async setMode(mode: TopicMode, query = ""): Promise<void> {
    this.mode = mode;
    this.query = query;
    this.category = undefined;
    if (this.initialized) {
      await this.resetAndLoad(false);
    }
  }

  private async resetAndLoad(loadCategories = true): Promise<void> {
    this.nextPage = 0;
    this.hasMore = true;
    this.topics.clear();
    await this.panel.webview.postMessage({
      type: "reset",
      mode: this.mode,
      query: this.query,
      categoryId: this.category?.id
    });
    if (loadCategories) {
      try {
        this.categories = await this.client.getCategories();
        await this.panel.webview.postMessage({
          type: "categories",
          categories: this.categories
        });
      } catch (error) {
        await this.postError(error);
        return;
      }
    }
    await this.loadNextPage();
  }

  private async loadNextPage(): Promise<void> {
    if (this.loading || !this.hasMore) {
      return;
    }
    this.loading = true;
    await this.panel.webview.postMessage({ type: "loading", value: true });
    try {
      const page = this.category
        ? await this.client.getCategoryLatest(this.category, this.nextPage)
        : this.mode === "latest"
          ? await this.client.getLatest(this.nextPage)
          : this.mode === "hot"
            ? await this.client.getHot(this.nextPage)
            : await this.client.search(this.query, this.nextPage);
      const additions = page.topics.filter((topic) => !this.topics.has(topic.id));
      for (const topic of additions) {
        this.topics.set(topic.id, topic);
      }
      this.hasMore = page.hasMore && additions.length > 0;
      this.nextPage += 1;
      await this.panel.webview.postMessage({
        type: "topics",
        topics: additions,
        hasMore: this.hasMore
      });
    } catch (error) {
      await this.postError(error);
    } finally {
      this.loading = false;
      await this.panel.webview.postMessage({ type: "loading", value: false });
    }
  }

  private async postError(error: unknown): Promise<void> {
    await this.panel.webview.postMessage({
      type: "error",
      message: toMessage(error),
      needsBrowser:
        error instanceof LinuxDoError && [401, 403, 428].includes(error.status ?? 0)
    });
  }

  private async toggleDisguise(): Promise<void> {
    await this.setDisguised(!this.disguised);
  }

  private async setDisguised(value: boolean): Promise<void> {
    if (this.disguised === value) {
      return;
    }
    this.disguised = value;
    this.updatePanelTitle();
    await this.panel.webview.postMessage({
      type: "disguise",
      value: this.disguised
    });
  }

  private updatePanelTitle(): void {
    this.panel.title = this.disguised
      ? vscode.workspace
          .getConfiguration("linuxDoReader")
          .get<string>("disguiseFileName", "workspace-utils.ts")
      : "Linux.do · 话题广场";
  }
}

class LauncherProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [
      launcherItem(
        "打开话题广场",
        "linuxDoReader.openTopicsPage",
        "window",
        "在独立编辑器页面浏览帖子"
      ),
      launcherItem(
        "连接专用 Chrome",
        "linuxDoReader.connectBrowser",
        "globe",
        "登录或完成 Cloudflare 验证"
      ),
      launcherItem(
        "设置",
        "linuxDoReader.openSettingsPanel",
        "settings-gear",
        "布局、伪装和浏览器配置"
      )
    ];
  }
}

function launcherItem(
  label: string,
  command: string,
  icon: string,
  description: string
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label };
  return item;
}

class SettingsPanel {
  private static panel?: vscode.WebviewPanel;

  static show(): void {
    if (SettingsPanel.panel) {
      SettingsPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "linuxDoReader.settings",
      "Linux.do 设置",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableCommandUris: false
      }
    );
    SettingsPanel.panel = panel;
    panel.onDidDispose(() => {
      SettingsPanel.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => void SettingsPanel.handle(message));
    panel.webview.html = settingsHtml(panel.webview);
  }

  private static async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const value = message as {
      type?: string;
      settings?: Record<string, unknown>;
    };
    if (value.type === "openKeyboardShortcuts") {
      await vscode.commands.executeCommand(
        "workbench.action.openGlobalKeybindings",
        "linuxDoReader"
      );
      return;
    }
    if (value.type === "connectBrowser") {
      const requestedPath = (value as { chromePath?: unknown }).chromePath;
      if (typeof requestedPath === "string") {
        await vscode.workspace
          .getConfiguration("linuxDoReader")
          .update("chromePath", requestedPath.trim(), vscode.ConfigurationTarget.Global);
      }
      await vscode.commands.executeCommand("linuxDoReader.connectBrowser");
      return;
    }
    if (value.type !== "save" || !value.settings) {
      return;
    }
    const allowed = [
      "topicListPlacement",
      "chromePath",
      "compactMode",
      "showImages",
      "previewImagesInVscode",
      "autoLoadPosts",
      "showTopicHeader",
      "enableInteractions",
      "confirmBeforeReply",
      "disguiseOnOpen",
      "disguiseFileName",
      "hideSidebarWhenDisguised",
      "quickActions"
    ] as const;
    const configuration = vscode.workspace.getConfiguration("linuxDoReader");
    const previousPlacement = configuration.get<string>("topicListPlacement", "editor");
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(value.settings, key)) {
        await configuration.update(
          key,
          value.settings[key],
          vscode.ConfigurationTarget.Global
        );
      }
    }
    const currentPlacement = configuration.get<string>("topicListPlacement", "editor");
    if (currentPlacement !== previousPlacement) {
      const choice = await vscode.window.showInformationMessage(
        "Linux.do 设置已保存。话题广场位置需要重载窗口后生效。",
        "重载窗口"
      );
      if (choice === "重载窗口") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else {
      void vscode.window.showInformationMessage("Linux.do 设置已保存，新打开的话题会使用新设置。");
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const browser = new BrowserSession(context);
  const client = new LinuxDoClient(context.secrets, browser);
  const placement = vscode.workspace
    .getConfiguration("linuxDoReader")
    .get<"editor" | "sidebar" | "both">("topicListPlacement", "editor");
  const sidebarProvider =
    placement === "sidebar" || placement === "both" ? new TopicsProvider(client) : undefined;
  const provider: vscode.TreeDataProvider<vscode.TreeItem> =
    sidebarProvider ?? new LauncherProvider();
  const tree = vscode.window.createTreeView("linuxDoReader.topics", {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  if (sidebarProvider) {
    tree.description = sidebarProvider.label;
  }

  const updateSidebar = async (action: () => Promise<void>): Promise<void> => {
    await action();
    if (sidebarProvider) {
      tree.description = sidebarProvider.label;
    }
  };

  const subscriptions: vscode.Disposable[] = [
    browser,
    client,
    tree,
    tree.onDidChangeVisibility((event) => {
      if (event.visible && placement === "editor") {
        void TopicsPagePanel.show(client, browser);
      }
    }),
    vscode.commands.registerCommand("linuxDoReader.openTopicsPage", () =>
      TopicsPagePanel.show(client, browser)
    ),
    vscode.commands.registerCommand("linuxDoReader.connectBrowser", async () => {
      if (await browser.connectInteractive()) {
        if (sidebarProvider) {
          await updateSidebar(() => sidebarProvider.refresh());
        }
        await TopicsPagePanel.reload();
      }
    }),
    vscode.commands.registerCommand("linuxDoReader.refresh", async () => {
      if (sidebarProvider) {
        await updateSidebar(() => sidebarProvider.refresh());
      }
      await TopicsPagePanel.reload();
    }),
    vscode.commands.registerCommand("linuxDoReader.showLatest", () =>
      sidebarProvider
        ? updateSidebar(() => sidebarProvider.showLatest())
        : TopicsPagePanel.show(client, browser, "latest")
    ),
    vscode.commands.registerCommand("linuxDoReader.showHot", () =>
      sidebarProvider
        ? updateSidebar(() => sidebarProvider.showHot())
        : TopicsPagePanel.show(client, browser, "hot")
    ),
    vscode.commands.registerCommand("linuxDoReader.loadMoreTopics", () =>
      sidebarProvider
        ? vscode.window.withProgress(
            {
              location: { viewId: "linuxDoReader.topics" },
              title: "加载更多话题…"
            },
            () => sidebarProvider.loadMore()
          )
        : undefined
    ),
    vscode.commands.registerCommand("linuxDoReader.search", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "搜索 Linux.do",
        placeHolder: "输入关键词",
        ignoreFocusOut: true
      });
      if (query?.trim()) {
        if (sidebarProvider) {
          await updateSidebar(() => sidebarProvider.showSearch(query.trim()));
        } else {
          await TopicsPagePanel.show(client, browser, "search", query.trim());
        }
      }
    }),
    vscode.commands.registerCommand("linuxDoReader.selectCategory", async () => {
      if (!sidebarProvider) {
        await TopicsPagePanel.show(client, browser, "latest");
        void vscode.window.showInformationMessage("请在话题广场顶部选择分类。");
        return;
      }
      try {
        const categories = await client.getCategories();
        const picks: Array<vscode.QuickPickItem & { category?: Category }> = [
          {
            label: "$(list-flat) 全部分类",
            description: "显示最新话题"
          },
          ...categories.map((category) => ({
            label: category.name,
            description:
              typeof category.topic_count === "number"
                ? `${category.topic_count} 个话题`
                : undefined,
            category
          }))
        ];
        const selected = await vscode.window.showQuickPick(picks, {
          title: "选择 Linux.do 分类",
          placeHolder: "输入文字可筛选分类",
          matchOnDescription: true
        });
        if (selected) {
          await updateSidebar(() => sidebarProvider.showCategory(selected.category));
        }
      } catch (error) {
        void showRequestError(error);
      }
    }),
    vscode.commands.registerCommand("linuxDoReader.openTopic", (topic: TopicSummary) =>
      TopicPanel.show(client, topic)
    ),
    vscode.commands.registerCommand("linuxDoReader.toggleDisguise", async () => {
      globalDisguised = !globalDisguised;
      const [topicCount, listCount] = await Promise.all([
        TopicPanel.setAllDisguised(globalDisguised),
        TopicsPagePanel.setAllDisguised(globalDisguised)
      ]);
      const hideSidebar = vscode.workspace
        .getConfiguration("linuxDoReader")
        .get<boolean>("hideSidebarWhenDisguised", false);
      const affected = topicCount + listCount;
      if (hideSidebar && affected > 0) {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
      }
      vscode.window.setStatusBarMessage(
        globalDisguised
          ? `$(code) 全局伪装已开启 · ${affected} 个页面`
          : `$(check) 已恢复 · ${affected} 个页面`,
        1600
      );
    }),
    vscode.commands.registerCommand("linuxDoReader.openSettingsPanel", () =>
      SettingsPanel.show()
    ),
    vscode.commands.registerCommand("linuxDoReader.setCookie", async () => {
      void vscode.window.showInformationMessage(
        "0.3.0 起改用持久化 Chrome，会话 Cookie 无需手工复制。"
      );
      await vscode.commands.executeCommand("linuxDoReader.connectBrowser");
    }),
    vscode.commands.registerCommand("linuxDoReader.clearCookie", async () => {
      await client.clearCookie();
      await browser.resetProfile();
      void vscode.window.showInformationMessage(
        "旧版 Cookie 已清除，专用 Chrome 会话已标记为未连接。"
      );
    }),
    vscode.commands.registerCommand("linuxDoReader.openSite", () =>
      vscode.env.openExternal(vscode.Uri.parse(BASE_URL))
    )
  ];

  context.subscriptions.push(...subscriptions);
}

export function deactivate(): void {}

function normalizeCookie(value: string): string {
  return value
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, "");
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (value >= 10000) {
    return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function topicsPage(payload: {
  topic_list?: { topics?: TopicSummary[]; more_topics_url?: string };
}): TopicsPage {
  const topics = payload.topic_list?.topics ?? [];
  return {
    topics,
    hasMore: Boolean(payload.topic_list?.more_topics_url) || topics.length >= 30
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function networkErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const value = cause as { code?: string; message?: string };
    if (value.code === "UND_ERR_CONNECT_TIMEOUT") {
      return "连接超时。请确认代理软件正在运行，并检查 VS Code 的 http.proxy 设置。";
    }
    if (value.code === "ECONNREFUSED") {
      return "代理或目标服务器拒绝连接，请确认代理软件和端口是否正确。";
    }
    if (value.code === "ENOTFOUND") {
      return "域名解析失败，请检查网络或代理设置。";
    }
    if (value.message) {
      return value.message;
    }
  }
  return error.message;
}

function proxyFromEnvironment(): string {
  const environment = process.env;
  return (
    environment.HTTPS_PROXY ||
    environment.https_proxy ||
    environment.HTTP_PROXY ||
    environment.http_proxy ||
    environment.ALL_PROXY ||
    environment.all_proxy ||
    ""
  ).trim();
}

function configuredProxy(): string {
  return (
    vscode.workspace.getConfiguration("http").get<string>("proxy", "").trim() ||
    proxyFromEnvironment()
  );
}

function findChromeExecutable(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("linuxDoReader")
    .get<string>("chromePath", "")
    .trim();
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    configured,
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function availablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 Chrome 调试端口"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForTargets(port: number): Promise<CdpTarget[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await undiciFetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = (await response.json()) as CdpTarget[];
        if (targets.some((target) => target.type === "page")) {
          return targets;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new LinuxDoError(`Chrome 调试端口启动超时：${toMessage(lastError)}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function showRequestError(error: unknown): Thenable<string | undefined> {
  const message = toMessage(error);
  if (error instanceof LinuxDoError && [401, 403, 428].includes(error.status ?? 0)) {
    return vscode.window
      .showErrorMessage(message, "打开 Chrome 登录/验证", "打开设置")
      .then(async (choice) => {
        if (choice === "打开 Chrome 登录/验证") {
          await vscode.commands.executeCommand("linuxDoReader.connectBrowser");
        } else if (choice === "打开设置") {
          SettingsPanel.show();
        }
        return choice;
      });
  }
  return vscode.window.showErrorMessage(message);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function safeExternalUri(value: string): vscode.Uri | undefined {
  try {
    const url = new URL(value, BASE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return vscode.Uri.parse(url.toString());
  } catch {
    return undefined;
  }
}

function cleanPostHtml(cooked: string): string {
  return sanitizeHtml(cooked, {
    allowedTags: [
      "a",
      "abbr",
      "aside",
      "b",
      "blockquote",
      "br",
      "code",
      "del",
      "details",
      "div",
      "em",
      "figcaption",
      "figure",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "kbd",
      "li",
      "mark",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "u",
      "ul"
    ],
    allowedAttributes: {
      "*": ["class", "title", "aria-label"],
      a: ["href"],
      img: ["src", "alt", "width", "height", "loading"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"]
    },
    allowedSchemes: ["http", "https"],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          href: absoluteUrl(attribs.href)
        }
      }),
      img: (_tagName, attribs) => ({
        tagName: "img",
        attribs: {
          ...attribs,
          src: absoluteUrl(attribs.src),
          loading: "lazy"
        }
      })
    }
  });
}

function absoluteUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    return new URL(value, BASE_URL).toString();
  } catch {
    return "";
  }
}

function postHtml(post: Post): string {
  const displayName = post.name?.trim() || post.username;
  const replyTo = post.reply_to_post_number ?? "";
  const interactionsEnabled = vscode.workspace
    .getConfiguration("linuxDoReader")
    .get<boolean>("enableInteractions", true);
  const likeAction = post.actions_summary?.find((action) => action.id === 2);
  const liked = Boolean(likeAction?.acted);
  const likeCount = likeAction?.count ?? 0;
  const canLike = likeAction?.can_act !== false || liked;
  const replyUser = post.reply_to_user
    ? `<span class="reply-target">↳ ${escapeHtml(
        post.reply_to_user.name?.trim() || `@${post.reply_to_user.username}`
      )}</span>`
    : "";
  return `<article class="post" data-post-id="${post.id}" data-post-number="${post.post_number}" data-reply-to="${replyTo}">
    <header class="post-header">
      <span class="author">${escapeHtml(displayName)}</span>
      <span class="username">@${escapeHtml(post.username)}</span>
      ${replyUser}
      <span class="post-number">#${post.post_number}</span>
      <time datetime="${escapeHtml(post.created_at)}">${escapeHtml(formatDate(post.created_at))}</time>
    </header>
    <div class="post-body">${cleanPostHtml(post.cooked)}</div>
    ${
      interactionsEnabled
        ? `<footer class="post-actions">
      <button class="post-action like-action${liked ? " is-active" : ""}" type="button"
        data-action="toggle-like" data-liked="${liked}" data-count="${likeCount}"
        ${canLike ? "" : 'disabled title="当前帖子不可点赞"'}>♥ ${liked ? "已赞" : "赞"}${
          likeCount ? ` ${likeCount}` : ""
        }</button>
      <button class="post-action reply-action" type="button" data-action="reply"
        data-username="${escapeHtml(post.username)}">回复</button>
    </footer>`
        : ""
    }
    <div class="post-children"></div>
  </article>`;
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function csp(webview: vscode.Webview, token: string): string {
  const showImages = vscode.workspace
    .getConfiguration("linuxDoReader")
    .get<boolean>("showImages", true);
  return [
    "default-src 'none'",
    `img-src ${showImages ? `${webview.cspSource} https: data:` : "'none'"}`,
    `style-src 'nonce-${token}'`,
    `script-src 'nonce-${token}'`
  ].join("; ");
}

function sharedStyle(): string {
  const compact = vscode.workspace
    .getConfiguration("linuxDoReader")
    .get<boolean>("compactMode", true);
  return `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0 auto;
      padding: ${compact ? "18px 24px 48px" : "28px 36px 64px"};
      max-width: 920px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font: 14px/1.65 var(--vscode-font-family);
    }
    .topic-head {
      position: sticky;
      top: 0;
      z-index: 2;
      margin: -18px -24px 14px;
      padding: 12px 24px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      backdrop-filter: blur(8px);
    }
    h1 { margin: 0; font-size: 18px; line-height: 1.4; }
    .topic-actions { margin-top: 6px; display: flex; gap: 8px; align-items: center; color: var(--vscode-descriptionForeground); }
    body.hide-topic-header .topic-head { display: none; }
    button {
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    .post {
      padding: ${compact ? "12px 0" : "20px 0"};
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .post-header {
      display: flex;
      gap: 7px;
      align-items: baseline;
      margin-bottom: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .author { color: var(--vscode-editor-foreground); font-weight: 650; font-size: 13px; }
    .post-number { margin-left: auto; }
    .reply-target {
      padding-left: 5px;
      color: var(--vscode-textLink-foreground);
      border-left: 1px solid var(--vscode-panel-border);
    }
    .post-children {
      margin-left: 18px;
      padding-left: 12px;
      border-left: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent);
    }
    .post-children:empty { display: none; }
    .post-children .post { padding-top: 10px; }
    .post-body { overflow-wrap: anywhere; }
    .post-body p:first-child { margin-top: 0; }
    .post-body p:last-child { margin-bottom: 0; }
    .post-body img { max-width: 100%; height: auto; border-radius: 4px; }
    .post-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .post-action {
      padding: 2px 8px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      font-size: 12px;
    }
    .post-action:hover {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-hoverBackground);
    }
    .post-action.is-active { color: var(--vscode-testing-iconPassed); }
    body.no-reply .reply-action { display: none; }
    .reply-composer {
      position: sticky;
      bottom: 10px;
      z-index: 4;
      margin-top: 16px;
      padding: 12px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 8px 28px var(--vscode-widget-shadow);
    }
    .reply-composer[hidden] { display: none; }
    .reply-composer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 650;
    }
    .reply-composer textarea {
      width: 100%;
      min-height: 120px;
      padding: 8px 10px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font: 13px/1.55 var(--vscode-editor-font-family);
    }
    .reply-composer-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .reply-composer-status { color: var(--vscode-descriptionForeground); }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { text-decoration: underline; }
    blockquote {
      margin: 10px 0;
      padding: 7px 12px;
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      background: var(--vscode-textBlockQuote-background);
    }
    pre {
      padding: 10px 12px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background);
    }
    code { font-family: var(--vscode-editor-font-family); }
    :not(pre) > code {
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
    }
    table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
    td, th { padding: 5px 8px; border: 1px solid var(--vscode-panel-border); }
    .load-wrap { padding: 18px 0; text-align: center; }
    .status { margin-left: 8px; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .image-preview {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: grid;
      place-items: center;
      padding: 36px;
      background: rgba(0, 0, 0, .82);
      cursor: zoom-out;
    }
    .image-preview[hidden] { display: none; }
    .image-preview img {
      max-width: min(96vw, 1600px);
      max-height: 90vh;
      object-fit: contain;
      border-radius: 5px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, .55);
      cursor: default;
    }
    .image-preview-close {
      position: fixed;
      top: 14px;
      right: 18px;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 50%;
      font-size: 22px;
    }
    .post-body img { cursor: zoom-in; }
    body.disguise {
      max-width: none;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.55;
    }
    body.disguise .topic-head { display: none; }
    body.disguise .post {
      padding: 4px 0;
      border: 0;
    }
    body.disguise .post-header {
      margin: 0;
      color: var(--vscode-editorLineNumber-foreground);
    }
    body.disguise .post-header::before { content: "//"; color: var(--vscode-editorLineNumber-foreground); }
    body.disguise .author { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    body.disguise .username,
    body.disguise .post-number,
    body.disguise time,
    body.disguise .reply-target { color: var(--vscode-editorLineNumber-foreground); }
    body.disguise .post-body {
      padding-left: 18px;
      color: var(--vscode-symbolIcon-stringForeground, #ce9178);
    }
    body.disguise .post-body p { margin: 3px 0; }
    body.disguise .post-body p::before { content: "/* "; color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    body.disguise .post-body p::after { content: " */"; color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    body.disguise .post-body img,
    body.disguise .post-actions,
    body.disguise .reply-composer,
    body.disguise .load-wrap { display: none; }
  `;
}

function topicHtml(
  webview: vscode.Webview,
  topic: TopicDetail,
  posts: Post[],
  hasMore: boolean,
  disguised: boolean
): string {
  const token = nonce();
  const title = decodeEntities(topic.fancy_title || topic.title);
  const configuration = vscode.workspace.getConfiguration("linuxDoReader");
  const showTopicHeader = configuration.get<boolean>("showTopicHeader", true);
  const autoLoadPosts = configuration.get<boolean>("autoLoadPosts", true);
  const previewImages = configuration.get<boolean>("previewImagesInVscode", true);
  const interactionsEnabled = configuration.get<boolean>("enableInteractions", true);
  const canReply = interactionsEnabled && topic.details?.can_create_post !== false;
  const quickActions = new Set(
    configuration.get<string[]>("quickActions", [
      "disguise",
      "reply",
      "openOriginal",
      "settings"
    ])
  );
  const actionButtons = [
    quickActions.has("disguise")
      ? `<button id="toggle-disguise" type="button">${disguised ? "退出伪装" : "伪装代码"}</button>`
      : "",
    quickActions.has("reply") && canReply
      ? '<button id="reply-topic" type="button">回复话题</button>'
      : "",
    quickActions.has("openOriginal")
      ? '<button id="open-original" type="button">浏览器打开</button>'
      : "",
    quickActions.has("settings")
      ? '<button id="open-settings" type="button">设置</button>'
      : ""
  ].join("");
  const bodyClasses = [
    showTopicHeader ? "" : "hide-topic-header",
    canReply ? "" : "no-reply",
    disguised ? "disguise" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}">
    <title>${escapeHtml(title)}</title>
    <style nonce="${token}">${sharedStyle()}</style>
  </head>
  <body class="${bodyClasses}">
    <header class="topic-head">
      <h1>${escapeHtml(title)}</h1>
      <div class="topic-actions">
        ${actionButtons}
        <span>${topic.posts_count} 条帖子</span>
      </div>
    </header>
    <main id="posts">${posts.map(postHtml).join("")}</main>
    <div class="load-wrap">
      <button id="load-more" type="button"${hasMore ? "" : " hidden"}>继续加载回复</button>
      <span id="status" class="status"></span>
    </div>
    <div id="load-sentinel" aria-hidden="true"></div>
    ${
      canReply
        ? `<section id="reply-composer" class="reply-composer" hidden>
      <div class="reply-composer-head">
        <span id="reply-title">回复话题</span>
        <button id="reply-close" type="button" title="关闭">×</button>
      </div>
      <textarea id="reply-content" maxlength="32000" placeholder="支持 Markdown。回复将使用当前专用 Chrome 中登录的 Linux.do 账号发布。"></textarea>
      <div class="reply-composer-actions">
        <button id="reply-submit" type="button">发布回复</button>
        <button id="reply-cancel" type="button">取消</button>
        <span id="reply-status" class="reply-composer-status"></span>
      </div>
    </section>`
        : ""
    }
    <div id="image-preview" class="image-preview" hidden role="dialog" aria-modal="true" aria-label="图片预览">
      <button id="image-preview-close" class="image-preview-close" type="button" aria-label="关闭">×</button>
      <img id="image-preview-content" alt="">
    </div>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      const loadButton = document.getElementById("load-more");
      const status = document.getElementById("status");
      const autoLoad = ${JSON.stringify(autoLoadPosts)};
      const previewImages = ${JSON.stringify(previewImages)};
      let hasMore = ${JSON.stringify(hasMore)};
      let loading = false;
      const imagePreview = document.getElementById("image-preview");
      const imagePreviewContent = document.getElementById("image-preview-content");
      const replyComposer = document.getElementById("reply-composer");
      const replyContent = document.getElementById("reply-content");
      const replyTitle = document.getElementById("reply-title");
      const replySubmit = document.getElementById("reply-submit");
      const replyStatus = document.getElementById("reply-status");
      let replyToPostNumber;
      function openReplyComposer(postNumber, username) {
        if (!replyComposer) return;
        replyToPostNumber = postNumber;
        replyTitle.textContent = postNumber
          ? "回复 @" + username + " · #" + postNumber
          : "回复话题";
        replyStatus.textContent = "";
        replyComposer.hidden = false;
        replyContent.focus();
        replyComposer.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      function closeReplyComposer(clear = false) {
        if (!replyComposer) return;
        replyComposer.hidden = true;
        replyToPostNumber = undefined;
        replyStatus.textContent = "";
        if (clear) replyContent.value = "";
      }
      function closeImagePreview() {
        imagePreview.hidden = true;
        imagePreviewContent.removeAttribute("src");
      }
      function arrangeReplies(root = document) {
        const articles = Array.from(root.querySelectorAll(".post[data-reply-to]"));
        for (const article of articles) {
          const replyTo = article.dataset.replyTo;
          if (!replyTo || article.dataset.arranged === "true") continue;
          const parent = document.querySelector('.post[data-post-number="' + CSS.escape(replyTo) + '"]');
          if (!parent || parent === article || article.contains(parent)) continue;
          let target = parent;
          let depth = 0;
          while (target.closest(".post-children")) {
            depth += 1;
            const ancestor = target.parentElement?.closest(".post");
            if (!ancestor) break;
            target = ancestor;
          }
          const container = depth >= 3
            ? target.querySelector(":scope > .post-children")
            : parent.querySelector(":scope > .post-children");
          container?.appendChild(article);
          article.dataset.arranged = "true";
        }
      }
      arrangeReplies();
      document.getElementById("open-original")?.addEventListener("click", () => {
        vscode.postMessage({ type: "openOriginal" });
      });
      document.getElementById("toggle-disguise")?.addEventListener("click", () => {
        vscode.postMessage({ type: "toggleDisguise" });
      });
      document.getElementById("open-settings")?.addEventListener("click", () => {
        vscode.postMessage({ type: "openSettings" });
      });
      document.getElementById("reply-topic")?.addEventListener("click", () => {
        openReplyComposer();
      });
      document.getElementById("reply-close")?.addEventListener("click", () => {
        closeReplyComposer();
      });
      document.getElementById("reply-cancel")?.addEventListener("click", () => {
        closeReplyComposer();
      });
      replySubmit?.addEventListener("click", () => {
        const raw = replyContent.value.trim();
        if (!raw) {
          replyStatus.textContent = "请先输入回复内容。";
          return;
        }
        vscode.postMessage({ type: "submitReply", raw, replyToPostNumber });
      });
      function requestMore() {
        if (!loading && hasMore && !document.body.classList.contains("disguise")) {
          vscode.postMessage({ type: "loadMore" });
        }
      }
      loadButton.addEventListener("click", requestMore);
      if (autoLoad) {
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) requestMore();
        }, { rootMargin: "600px 0px" });
        observer.observe(document.getElementById("load-sentinel"));
      }
      document.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]");
        if (action?.dataset.action === "toggle-like") {
          const post = action.closest(".post");
          if (!post || action.disabled) return;
          vscode.postMessage({
            type: "toggleLike",
            postId: Number(post.dataset.postId),
            liked: action.dataset.liked === "true",
            count: Number(action.dataset.count || 0)
          });
          return;
        }
        if (action?.dataset.action === "reply") {
          const post = action.closest(".post");
          if (!post) return;
          openReplyComposer(Number(post.dataset.postNumber), action.dataset.username || "");
          return;
        }
        const postImage = event.target.closest(".post-body img");
        if (postImage && previewImages) {
          event.preventDefault();
          event.stopPropagation();
          imagePreviewContent.src = postImage.currentSrc || postImage.src;
          imagePreviewContent.alt = postImage.alt || "帖子图片";
          imagePreview.hidden = false;
          return;
        }
        const link = event.target.closest("a[href]");
        if (!link) return;
        event.preventDefault();
        vscode.postMessage({ type: "openLink", href: link.href });
      });
      document.getElementById("image-preview-close").addEventListener("click", closeImagePreview);
      imagePreview.addEventListener("click", (event) => {
        if (event.target === imagePreview) closeImagePreview();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !imagePreview.hidden) closeImagePreview();
      });
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "appendPosts") {
          document.getElementById("posts").insertAdjacentHTML("beforeend", message.html);
          arrangeReplies();
          hasMore = message.hasMore;
          loadButton.hidden = !hasMore;
          status.textContent = "";
        } else if (message.type === "loading") {
          loading = message.value;
          loadButton.disabled = message.value;
          status.textContent = message.value ? "加载中…" : "";
        } else if (message.type === "loadError") {
          status.textContent = message.message;
          status.className = "status error";
        } else if (message.type === "likeBusy") {
          const button = document.querySelector(
            '.post[data-post-id="' + message.postId + '"] [data-action="toggle-like"]'
          );
          if (button) button.disabled = message.value;
        } else if (message.type === "likeUpdated") {
          const button = document.querySelector(
            '.post[data-post-id="' + message.postId + '"] [data-action="toggle-like"]'
          );
          if (button) {
            button.dataset.liked = String(message.liked);
            button.dataset.count = String(message.count);
            button.classList.toggle("is-active", message.liked);
            button.textContent =
              "♥ " + (message.liked ? "已赞" : "赞") + (message.count ? " " + message.count : "");
          }
        } else if (message.type === "actionError") {
          status.textContent = message.message;
          status.className = "status error";
        } else if (message.type === "replyBusy") {
          if (replySubmit) replySubmit.disabled = message.value;
          if (replyContent) replyContent.disabled = message.value;
          if (replyStatus) replyStatus.textContent = message.value ? "正在发布…" : "";
        } else if (message.type === "replyCreated") {
          document.getElementById("posts").insertAdjacentHTML("beforeend", message.html);
          arrangeReplies();
          closeReplyComposer(true);
          status.className = "status";
          status.textContent = "回复已发布 · #" + message.postNumber;
        } else if (message.type === "replySubmitted") {
          closeReplyComposer(true);
          status.className = "status";
          status.textContent = message.message;
        } else if (message.type === "replyError") {
          if (replyStatus) {
            replyStatus.textContent = message.message;
            replyStatus.className = "reply-composer-status error";
          }
        } else if (message.type === "disguise") {
          document.body.classList.toggle("disguise", message.value);
          const disguiseButton = document.getElementById("toggle-disguise");
          if (disguiseButton) disguiseButton.textContent = message.value ? "退出伪装" : "伪装代码";
        }
      });
    </script>
  </body>
  </html>`;
}

function loadingHtml(webview: vscode.Webview, title: string): string {
  const token = nonce();
  return `<!doctype html><html lang="zh-CN"><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}">
    <style nonce="${token}">${sharedStyle()}</style>
  </head><body><h1>${escapeHtml(decodeEntities(title))}</h1><p>正在加载话题…</p></body></html>`;
}

function errorHtml(webview: vscode.Webview, message: string): string {
  const token = nonce();
  return `<!doctype html><html lang="zh-CN"><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}">
    <style nonce="${token}">${sharedStyle()}</style>
  </head><body><h1>无法打开话题</h1><p class="error">${escapeHtml(message)}</p></body></html>`;
}

function settingsHtml(webview: vscode.Webview): string {
  const token = nonce();
  const configuration = vscode.workspace.getConfiguration("linuxDoReader");
  const checked = (key: string, fallback: boolean): string =>
    configuration.get<boolean>(key, fallback) ? " checked" : "";
  const quickActions = new Set(
    configuration.get<string[]>("quickActions", [
      "disguise",
      "reply",
      "openOriginal",
      "settings"
    ])
  );
  const fileName = configuration.get<string>("disguiseFileName", "workspace-utils.ts");
  const chromePath = configuration.get<string>("chromePath", "");
  const topicListPlacement = configuration.get<string>("topicListPlacement", "editor");
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}">
    <title>Linux.do 设置</title>
    <style nonce="${token}">
      ${sharedStyle()}
      body { max-width: 760px; padding-top: 32px; }
      h1 { font-size: 24px; margin-bottom: 8px; }
      .lead { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
      fieldset {
        margin: 0 0 18px;
        padding: 16px 18px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
      }
      legend { padding: 0 7px; font-weight: 650; }
      label.option {
        display: grid;
        grid-template-columns: 20px 1fr;
        gap: 7px;
        margin: 10px 0;
        cursor: pointer;
      }
      label.option small {
        grid-column: 2;
        color: var(--vscode-descriptionForeground);
      }
      label.text { display: block; margin: 10px 0 5px; }
      input[type="text"] {
        width: 100%;
        padding: 7px 9px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        font: inherit;
      }
      select {
        width: 100%;
        padding: 7px 9px;
        color: var(--vscode-dropdown-foreground);
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border, transparent);
        font: inherit;
      }
      textarea {
        width: 100%;
        min-height: 92px;
        padding: 8px 9px;
        resize: vertical;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        font: 12px/1.5 var(--vscode-editor-font-family);
      }
      input[type="password"] {
        width: 100%;
        padding: 7px 9px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        font: 12px/1.5 var(--vscode-editor-font-family);
      }
      .inline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .actions {
        position: sticky;
        bottom: 0;
        display: flex;
        gap: 8px;
        padding: 14px 0;
        background: var(--vscode-editor-background);
      }
      #saved { align-self: center; color: var(--vscode-testing-iconPassed); }
    </style>
  </head>
  <body>
    <h1>Linux.do 设置</h1>
    <p class="lead">这里保存的是 VS Code 全局设置。已经打开的话题需要重新打开后才会完整应用。</p>
    <form id="settings-form">
      <fieldset>
        <legend>话题广场</legend>
        <label class="text" for="topicListPlacement">显示位置</label>
        <select id="topicListPlacement">
          <option value="editor"${
            topicListPlacement === "editor" ? " selected" : ""
          }>独立页面</option>
          <option value="sidebar"${
            topicListPlacement === "sidebar" ? " selected" : ""
          }>左侧栏</option>
          <option value="both"${
            topicListPlacement === "both" ? " selected" : ""
          }>左侧栏和独立页面</option>
        </select>
        <small>改变显示位置后需要重载 VS Code 窗口。</small>
      </fieldset>
      <fieldset>
        <legend>连接与会话</legend>
        <label class="text" for="chromePath">Chrome / Edge 路径</label>
        <input id="chromePath" type="text" value="${escapeHtml(
          chromePath
        )}" placeholder="留空自动检测 Chrome 或 Edge">
        <small>插件使用独立持久化浏览器 Profile，不会读取你日常浏览器的数据。</small>
        <div class="inline-actions">
          <button id="connect-browser" type="button">打开 Chrome 登录/验证</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>阅读布局</legend>
        <label class="option">
          <input id="compactMode" type="checkbox"${checked("compactMode", true)}>
          <span>紧凑布局</span>
          <small>减少帖子间距，在一屏内显示更多内容。</small>
        </label>
        <label class="option">
          <input id="showTopicHeader" type="checkbox"${checked("showTopicHeader", true)}>
          <span>显示顶部话题标题</span>
          <small>关闭后阅读页顶部不显示话题名和工具栏。</small>
        </label>
        <label class="option">
          <input id="showImages" type="checkbox"${checked("showImages", true)}>
          <span>加载帖子图片</span>
          <small>关闭可减少流量，也让页面更像普通文本。</small>
        </label>
        <label class="option">
          <input id="previewImagesInVscode" type="checkbox"${checked(
            "previewImagesInVscode",
            true
          )}>
          <span>在 VS Code 内放大图片</span>
          <small>点击图片时使用遮罩预览；关闭后图片链接仍交给浏览器。</small>
        </label>
        <label class="option">
          <input id="autoLoadPosts" type="checkbox"${checked("autoLoadPosts", true)}>
          <span>滚动到底自动加载回复</span>
          <small>关闭后保留“继续加载回复”按钮。</small>
        </label>
      </fieldset>
      <fieldset>
        <legend>互动</legend>
        <label class="option">
          <input id="enableInteractions" type="checkbox"${checked("enableInteractions", true)}>
          <span>显示回复和点赞</span>
          <small>所有互动都需要手动点击，并使用专用 Chrome 当前登录的 Linux.do 账号。</small>
        </label>
        <label class="option">
          <input id="confirmBeforeReply" type="checkbox"${checked("confirmBeforeReply", true)}>
          <span>发布回复前二次确认</span>
          <small>点击“发布回复”后，由 VS Code 再询问一次，避免误发。</small>
        </label>
      </fieldset>
      <fieldset>
        <legend>代码伪装</legend>
        <label class="option">
          <input id="disguiseOnOpen" type="checkbox"${checked("disguiseOnOpen", false)}>
          <span>打开话题时自动伪装</span>
          <small>使用等宽字体、注释和语法配色显示帖子。</small>
        </label>
        <label class="option">
          <input id="hideSidebarWhenDisguised" type="checkbox"${checked(
            "hideSidebarWhenDisguised",
            false
          )}>
          <span>切换伪装时同时切换侧栏</span>
          <small>适合一键隐藏明显的话题列表。</small>
        </label>
        <label class="text" for="disguiseFileName">伪装标签页文件名</label>
        <input id="disguiseFileName" type="text" value="${escapeHtml(fileName)}" maxlength="80">
      </fieldset>
      <fieldset>
        <legend>阅读器快捷按钮</legend>
        <label class="option">
          <input name="quickAction" value="disguise" type="checkbox"${
            quickActions.has("disguise") ? " checked" : ""
          }>
          <span>伪装代码</span>
        </label>
        <label class="option">
          <input name="quickAction" value="reply" type="checkbox"${
            quickActions.has("reply") ? " checked" : ""
          }>
          <span>回复话题</span>
        </label>
        <label class="option">
          <input name="quickAction" value="openOriginal" type="checkbox"${
            quickActions.has("openOriginal") ? " checked" : ""
          }>
          <span>浏览器打开</span>
        </label>
        <label class="option">
          <input name="quickAction" value="settings" type="checkbox"${
            quickActions.has("settings") ? " checked" : ""
          }>
          <span>设置</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>键盘快捷键</legend>
        <p><code>Ctrl+Alt+L</code> 默认切换代码伪装，可以在 VS Code 键盘快捷方式中自行修改。</p>
        <button id="keyboard-shortcuts" type="button">自定义快捷键</button>
      </fieldset>
      <div class="actions">
        <button type="submit">保存设置</button>
        <span id="saved"></span>
      </div>
    </form>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      const form = document.getElementById("settings-form");
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const boolKeys = [
          "compactMode",
          "showImages",
          "previewImagesInVscode",
          "autoLoadPosts",
          "showTopicHeader",
          "enableInteractions",
          "confirmBeforeReply",
          "disguiseOnOpen",
          "hideSidebarWhenDisguised"
        ];
        const settings = {};
        for (const key of boolKeys) settings[key] = document.getElementById(key).checked;
        settings.topicListPlacement = document.getElementById("topicListPlacement").value;
        settings.chromePath = document.getElementById("chromePath").value.trim();
        settings.disguiseFileName =
          document.getElementById("disguiseFileName").value.trim() || "workspace-utils.ts";
        settings.quickActions = Array.from(
          document.querySelectorAll('input[name="quickAction"]:checked')
        ).map((input) => input.value);
        vscode.postMessage({ type: "save", settings });
        document.getElementById("saved").textContent = "已保存";
        setTimeout(() => document.getElementById("saved").textContent = "", 1800);
      });
      document.getElementById("keyboard-shortcuts").addEventListener("click", () => {
        vscode.postMessage({ type: "openKeyboardShortcuts" });
      });
      document.getElementById("connect-browser").addEventListener("click", () => {
        vscode.postMessage({
          type: "connectBrowser",
          chromePath: document.getElementById("chromePath").value.trim()
        });
      });
    </script>
  </body>
  </html>`;
}

function topicsPageHtml(webview: vscode.Webview, disguised: boolean): string {
  const token = nonce();
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}">
    <title>Linux.do · 话题广场</title>
    <style nonce="${token}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        font: 13px/1.5 var(--vscode-font-family);
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 5;
        display: grid;
        grid-template-columns: auto minmax(220px, 1fr) minmax(150px, 220px) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 18px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent);
        backdrop-filter: blur(8px);
      }
      .modes { display: flex; gap: 4px; }
      button, select, input {
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 3px;
        font: inherit;
      }
      button { padding: 5px 10px; cursor: pointer; }
      button:hover, button.active {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
      }
      input, select { width: 100%; padding: 6px 9px; }
      .search { display: flex; gap: 5px; }
      .actions { display: flex; gap: 5px; }
      main { max-width: 980px; margin: 0 auto; padding: 10px 18px 60px; }
      .topic {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px 18px;
        width: 100%;
        padding: 11px 10px;
        color: inherit;
        background: transparent;
        border: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        border-radius: 0;
        text-align: left;
      }
      .topic:hover { background: var(--vscode-list-hoverBackground); color: inherit; }
      .topic-title { overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 550; }
      .topic-meta { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 12px; }
      .topic-tags {
        grid-column: 1 / -1;
        display: flex;
        gap: 5px;
        min-height: 16px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      .tag { padding: 0 5px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
      .status {
        padding: 18px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }
      .error {
        margin: 16px auto;
        max-width: 760px;
        padding: 14px 16px;
        color: var(--vscode-errorForeground);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        background: var(--vscode-inputValidation-errorBackground);
      }
      .error button { margin-top: 10px; }
      [hidden] { display: none !important; }
      body.disguise {
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
      }
      body.disguise .toolbar {
        position: fixed;
        inset: 5px 8px auto auto;
        display: block;
        padding: 0;
        border: 0;
        background: transparent;
        backdrop-filter: none;
      }
      body.disguise .toolbar > :not(.actions) { display: none; }
      body.disguise .actions #settings { display: none; }
      body.disguise #toggle-list-disguise {
        width: 30px;
        height: 26px;
        padding: 0;
        opacity: .16;
        color: var(--vscode-editorLineNumber-foreground);
        background: transparent;
        border: 0;
        font-family: var(--vscode-editor-font-family);
      }
      body.disguise #toggle-list-disguise:hover { opacity: .85; }
      body.disguise main { max-width: none; padding: 18px 42px 60px 22px; }
      body.disguise .topic {
        padding: 4px 8px;
        border: 0;
        font-family: var(--vscode-editor-font-family);
      }
      body.disguise .topic-title {
        color: var(--vscode-symbolIcon-stringForeground, #ce9178);
        font-size: inherit;
        font-weight: 400;
      }
      body.disguise .topic-title::before {
        content: "// ";
        color: var(--vscode-editorLineNumber-foreground);
      }
      body.disguise .topic-meta {
        color: var(--vscode-editorLineNumber-foreground);
        font-family: var(--vscode-editor-font-family);
      }
      body.disguise .topic-tags { display: none; }
      body.disguise .status::before { content: "// "; }
      @media (max-width: 720px) {
        .toolbar { grid-template-columns: 1fr; }
        .topic { grid-template-columns: 1fr; }
        .topic-meta { white-space: normal; }
      }
    </style>
  </head>
  <body class="${disguised ? "disguise" : ""}">
    <header class="toolbar">
      <div class="modes">
        <button id="latest" type="button" class="active">最新</button>
        <button id="hot" type="button">热门</button>
      </div>
      <form id="search-form" class="search">
        <input id="search-input" type="search" placeholder="搜索 Linux.do" aria-label="搜索">
        <button type="submit">搜索</button>
      </form>
      <select id="category" aria-label="分类">
        <option value="">全部分类</option>
      </select>
      <div class="actions">
        <button id="toggle-list-disguise" type="button" title="切换代码伪装">${
          disguised ? "{}" : "伪装"
        }</button>
        <button id="settings" type="button" title="Linux.do 设置">设置</button>
      </div>
    </header>
    <div id="error" class="error" hidden>
      <div id="error-message"></div>
      <button id="connect-browser" type="button" hidden>打开专用 Chrome</button>
    </div>
    <main>
      <div id="topics"></div>
      <div id="status" class="status">正在加载…</div>
      <div id="sentinel" aria-hidden="true"></div>
    </main>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      const topics = document.getElementById("topics");
      const status = document.getElementById("status");
      const errorBox = document.getElementById("error");
      const errorMessage = document.getElementById("error-message");
      const connectBrowser = document.getElementById("connect-browser");
      const category = document.getElementById("category");
      let loading = false;
      let hasMore = true;
      let initialized = false;
      const readyTimer = setInterval(() => {
        if (!initialized) vscode.postMessage({ type: "ready" });
      }, 500);

      const count = (value) => {
        if (value >= 10000) return (value / 10000).toFixed(value >= 100000 ? 0 : 1) + "万";
        if (value >= 1000) return (value / 1000).toFixed(1) + "k";
        return String(value || 0);
      };
      const topicElement = (topic) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "topic";
        button.dataset.topicId = String(topic.id);
        const title = document.createElement("span");
        title.className = "topic-title";
        title.textContent = topic.fancy_title || topic.title;
        const meta = document.createElement("span");
        meta.className = "topic-meta";
        meta.textContent =
          Math.max(0, (topic.posts_count || 1) - 1) + " 回复 · " +
          count(topic.views) + " 浏览";
        const tags = document.createElement("span");
        tags.className = "topic-tags";
        for (const value of topic.tags || []) {
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = value;
          tags.appendChild(tag);
        }
        button.append(title, meta, tags);
        return button;
      };
      const requestMore = () => {
        if (!loading && hasMore) vscode.postMessage({ type: "loadMore" });
      };
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestMore();
      }, { rootMargin: "700px 0px" }).observe(document.getElementById("sentinel"));

      document.getElementById("latest").addEventListener("click", () => {
        vscode.postMessage({ type: "mode", mode: "latest" });
      });
      document.getElementById("hot").addEventListener("click", () => {
        vscode.postMessage({ type: "mode", mode: "hot" });
      });
      document.getElementById("search-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const query = document.getElementById("search-input").value.trim();
        if (query) vscode.postMessage({ type: "search", query });
      });
      category.addEventListener("change", () => {
        vscode.postMessage({
          type: "category",
          categoryId: category.value ? Number(category.value) : null
        });
      });
      topics.addEventListener("click", (event) => {
        const item = event.target.closest(".topic[data-topic-id]");
        if (item) vscode.postMessage({ type: "openTopic", topicId: Number(item.dataset.topicId) });
      });
      connectBrowser.addEventListener("click", () => {
        vscode.postMessage({ type: "connectBrowser" });
      });
      document.getElementById("settings").addEventListener("click", () => {
        vscode.postMessage({ type: "settings" });
      });
      document.getElementById("toggle-list-disguise").addEventListener("click", () => {
        vscode.postMessage({ type: "toggleDisguise" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "reset") {
          initialized = true;
          clearInterval(readyTimer);
          topics.replaceChildren();
          hasMore = true;
          errorBox.hidden = true;
          document.getElementById("latest").classList.toggle("active", message.mode === "latest");
          document.getElementById("hot").classList.toggle("active", message.mode === "hot");
          document.getElementById("search-input").value = message.query || "";
          category.value = message.categoryId ? String(message.categoryId) : "";
        } else if (message.type === "categories") {
          const selected = category.value;
          category.replaceChildren(new Option("全部分类", ""));
          for (const item of message.categories) {
            category.appendChild(new Option(item.name, String(item.id)));
          }
          category.value = selected;
        } else if (message.type === "topics") {
          for (const topic of message.topics) topics.appendChild(topicElement(topic));
          hasMore = message.hasMore;
          status.textContent = hasMore ? "继续向下滚动加载" : "已经到底了";
        } else if (message.type === "loading") {
          loading = message.value;
          if (loading) status.textContent = "正在加载…";
        } else if (message.type === "error") {
          errorMessage.textContent = message.message;
          connectBrowser.hidden = !message.needsBrowser;
          errorBox.hidden = false;
          status.textContent = "";
          hasMore = false;
        } else if (message.type === "disguise") {
          document.body.classList.toggle("disguise", message.value);
          document.getElementById("toggle-list-disguise").textContent =
            message.value ? "{}" : "伪装";
        }
      });
      vscode.postMessage({ type: "ready" });
    </script>
  </body>
  </html>`;
}
