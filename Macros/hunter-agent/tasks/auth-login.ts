import { Task, TaskResult } from "../../util/scheduler.ts";
import { closeContainer, consumeSentCommand, log, sayCommand, stopPathing, type HunterContext } from "../actions.ts";
import { AUTH_HOLD_MS, TaskPriority, authLoginCommand } from "../config.ts";
import { isInLoginServer } from "../login.ts";

export class AuthLoginTask extends Task {
  private sentAt = 0;
  private queued = false;
  private sent = false;

  constructor() {
    super("auth-login", TaskPriority.authLogin);
  }

  shouldRun(context: HunterContext): boolean {
    return context.needsAuthLogin && !isInLoginServer();
  }

  start(): void {
    this.sent = false;
    this.sentAt = 0;
    this.queued = false;
  }

  resume(): void {
    this.start();
  }

  tick(context: HunterContext): string {
    if (isInLoginServer()) {
      context.needsAuthLogin = false;
      return TaskResult.RUNNING;
    }
    if (!this.sent) {
      const command = authLoginCommand();
      const sent = consumeSentCommand();
      if (sent === command) {
        log(`已发送 ${command}`);
        this.sent = true;
        this.sentAt = Date.now();
        return TaskResult.RUNNING;
      }
      if (!this.queued) {
        stopPathing();
        closeContainer();
        sayCommand(command);
        this.queued = true;
      }
      return TaskResult.RUNNING;
    }
    if (Date.now() - this.sentAt >= AUTH_HOLD_MS) {
      log("登录等待结束");
      context.needsAuthLogin = false;
    }
    return TaskResult.RUNNING;
  }
}
