import { Task, TaskResult } from "../../util/scheduler.ts";
import { closeContainer, log } from "../actions.ts";
import { BAN_WAIT_MS, LOGIN_RETRY_MS, RETURN_SLOT, TaskPriority } from "../config.ts";
import { isInLoginServer } from "../login.ts";

type LoginPhase = "wait" | "use" | "menu" | "click" | "close" | "retry";

export class ServerLoginTask extends Task {
  private phase: LoginPhase = "wait";
  private waitUntil = 0;
  private openedAt = 0;
  private closeAt = 0;

  constructor() {
    super("server-login", TaskPriority.serverLogin);
  }

  shouldRun(): boolean {
    return isInLoginServer();
  }

  start(): void {
    this.beginWait();
  }

  resume(): void {
    this.beginWait();
  }

  abort(): void {
    closeContainer();
  }

  tick(): string {
    if (this.phase === "wait") return this.waitOutBan();
    if (this.phase === "use") return this.useMenu();
    if (this.phase === "menu") return this.waitMenu();
    if (this.phase === "click") return this.clickReturn();
    if (this.phase === "close") return this.finishClick();
    return this.retry();
  }

  private beginWait(): void {
    closeContainer();
    this.phase = "wait";
    this.waitUntil = Date.now() + BAN_WAIT_MS;
    log(`在登录服，${BAN_WAIT_MS / 1000} 秒后打开主手菜单`);
  }

  private waitOutBan(): string {
    if (Date.now() < this.waitUntil) return TaskResult.RUNNING;
    this.phase = "use";
    return TaskResult.RUNNING;
  }

  private useMenu(): string {
    Player.getInteractionManager()?.interactItem(false);
    log("右键主手菜单");
    this.phase = "menu";
    this.openedAt = Date.now();
    return TaskResult.RUNNING;
  }

  private waitMenu(): string {
    const inv = Player.openInventory();
    if (inv?.isContainer()) {
      log(`主手菜单已打开：${inv.getContainerTitle()}`);
      this.phase = "click";
      this.closeAt = Date.now() + 300;
      return TaskResult.RUNNING;
    }
    if (Date.now() - this.openedAt > 8_000) {
      log(`主手菜单没有打开，${LOGIN_RETRY_MS / 1000} 秒后重试`);
      this.phase = "retry";
      this.waitUntil = Date.now() + LOGIN_RETRY_MS;
    }
    return TaskResult.RUNNING;
  }

  private clickReturn(): string {
    if (Date.now() < this.closeAt) return TaskResult.RUNNING;
    Player.openInventory()?.click(RETURN_SLOT, 0);
    this.phase = "close";
    this.closeAt = Date.now() + 600;
    return TaskResult.RUNNING;
  }

  private finishClick(): string {
    if (Date.now() < this.closeAt) return TaskResult.RUNNING;
    closeContainer();
    log(`已点击第 ${RETURN_SLOT} 格`);
    this.phase = "retry";
    this.waitUntil = Date.now() + LOGIN_RETRY_MS;
    return TaskResult.RUNNING;
  }

  private retry(): string {
    if (Date.now() < this.waitUntil) return TaskResult.RUNNING;
    this.phase = "use";
    return TaskResult.RUNNING;
  }
}
