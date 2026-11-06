import { Task, TaskResult } from "../../util/scheduler.ts";
import { canDoFieldWork, log, needsSuicide, sayCommand, stopPathing, type HunterContext } from "../actions.ts";
import { SUICIDE_RETRY_MS, TaskPriority, suicideCommand } from "../config.ts";

export class SuicideTask extends Task {
  private nextKillAt = 0;

  constructor() {
    super("suicide", TaskPriority.suicide);
  }

  shouldRun(context: HunterContext): boolean {
    return canDoFieldWork(context) && needsSuicide();
  }

  start(): void {
    this.nextKillAt = 0;
    stopPathing();
  }

  resume(): void {
    this.start();
  }

  tick(): string {
    if (Date.now() < this.nextKillAt) return TaskResult.RUNNING;
    const player = Player.getPlayer();
    const health = player ? player.getHealth().toFixed(1) : "?";
    const food = player ? String(player.getFoodLevel()) : "?";
    log(`血量 ${health}，饥饿 ${food}，执行 ${suicideCommand}`);
    stopPathing();
    sayCommand(suicideCommand);
    this.nextKillAt = Date.now() + SUICIDE_RETRY_MS;
    return TaskResult.RUNNING;
  }
}
