import { Task, TaskResult } from "../../util/scheduler.ts";
import {
  canDoFieldWork,
  closeContainer,
  consumeSentCommand,
  containerTitle,
  log,
  openContainer,
  toArray,
  sayCommand,
  selectHotbar,
  stopPathing,
  type HunterContext,
} from "../actions.ts";
import {
  ACTIVE_QUEST_NAME,
  QUEST_ACCEPT_SLOT,
  QUEST_CONFIRM_SLOT,
  QUEST_LIST_TITLE,
  QUEST_NPC_COMMAND,
  QUEST_TURNIN_SLOT,
  SWORD_HOTBAR,
  TaskPriority,
} from "../config.ts";
import { plainText } from "../login.ts";

type QuestMode = "accept" | "turnin";
type QuestPhase = "idle" | "open" | "click-entry" | "wait-detail" | "click-confirm" | "retry";

const CLICK_WAIT_MS = 1_000;
const MENU_WAIT_MS = 6_000;

export class QuestTask extends Task {
  private engaged = false;
  private mode: QuestMode = "accept";
  /** 交付后接着接取。中途被打断也要接着接，不要再去交付一次。 */
  private followingTurnIn = false;
  private phase: QuestPhase = "idle";
  private nextStepAt = 0;
  private commandSent = false;
  private entryClicked = false;
  private confirmClicked = false;
  /** 开始这次接取时，聊天里上一次「已接受」的时间。 */
  private acceptBaseline = 0;

  constructor() {
    super("quest", TaskPriority.quest);
  }

  shouldRun(context: HunterContext): boolean {
    if (!canDoFieldWork(context)) return false;
    if (context.clearForQuest && !context.questTurnInReady) return false;
    if (this.engaged) return true;
    if (context.questTurnInReady) return true;
    return !context.questActive && !context.questComplete;
  }

  start(context: HunterContext): void {
    this.engaged = true;
    if (context.questTurnInReady) {
      this.mode = "turnin";
      this.followingTurnIn = false;
    } else if (!this.followingTurnIn) this.mode = "accept";
    log(this.mode === "turnin" ? "交付任务" : "接取任务");
    this.acceptBaseline = context.questAcceptSeenAt;
    this.begin();
  }

  resume(context: HunterContext): void {
    this.engaged = true;
    if (context.questTurnInReady) {
      this.mode = "turnin";
      this.followingTurnIn = false;
    } else if (!this.followingTurnIn) this.mode = "accept";
    log(this.mode === "turnin" ? "继续交付任务" : "继续接取任务");
    this.acceptBaseline = context.questAcceptSeenAt;
    this.begin();
  }

  suspend(): void {
    this.releasePointer();
    stopPathing();
    closeContainer();
  }

  abort(): void {
    this.engaged = false;
    this.followingTurnIn = false;
    this.phase = "idle";
    this.suspend();
    selectHotbar(SWORD_HOTBAR);
  }

  tick(context: HunterContext): string {
    if (this.acceptedSinceStart(context)) return this.finishAccept(context);
    if (this.alreadyHaveQuest(context)) return this.leaveExisting(context);
    if (this.phase === "open") return this.openMenu();
    if (this.phase === "click-entry") return this.clickEntry(context);
    if (this.phase === "wait-detail") return this.waitForDetail();
    if (this.phase === "click-confirm") return this.clickConfirm(context);
    if (this.phase === "retry") return this.retry(context);
    this.phase = "open";
    return TaskResult.RUNNING;
  }

  private begin(): void {
    this.releasePointer();
    stopPathing();
    closeContainer();
    this.phase = "open";
    this.commandSent = false;
    this.entryClicked = false;
    this.confirmClicked = false;
    this.nextStepAt = 0;
  }

  /** 松开右键和前进，避免卡住按键。 */
  private releasePointer(): void {
    KeyBind.keyBind("key.use", false);
    KeyBind.keyBind("key.forward", false);
    try {
      Player.getInteractionManager()?.holdInteract(false);
      Player.getInteractionManager()?.clearTargetOverride();
    } catch {
      // 换世界时交互器可能已经卸了。
    }
  }

  private acceptedSinceStart(context: HunterContext): boolean {
    return this.mode === "accept" && context.questAcceptSeenAt > this.acceptBaseline;
  }

  private alreadyHaveQuest(context: HunterContext): boolean {
    if (this.followingTurnIn || this.mode !== "accept") return false;
    if (context.questProgress < 0 || context.questTotal <= 0) return false;
    if (context.questProgress >= context.questTotal) return false;
    return this.phase === "open" || this.phase === "retry";
  }

  private leaveExisting(context: HunterContext): string {
    return this.stopAccept(context, `已有任务进度 ${context.questProgress} / ${context.questTotal}，不再重复接取`);
  }

  private stopAccept(context: HunterContext, message: string): string {
    log(message);
    this.releasePointer();
    closeContainer();
    stopPathing();
    selectHotbar(SWORD_HOTBAR);
    context.questActive = true;
    this.engaged = false;
    this.phase = "idle";
    return TaskResult.RUNNING;
  }

  private openMenu(): string {
    if (this.commandSent && this.nextStepAt === 0 && consumeSentCommand() === QUEST_NPC_COMMAND) {
      this.nextStepAt = Date.now() + MENU_WAIT_MS;
      log(`已发送 ${QUEST_NPC_COMMAND}`);
    }
    if (openContainer()) {
      if (!containerTitle().includes(QUEST_LIST_TITLE)) {
        closeContainer();
        return TaskResult.RUNNING;
      }
      noteOpenedScreen();
      this.phase = "click-entry";
      this.entryClicked = false;
      return TaskResult.RUNNING;
    }
    if (!this.commandSent) {
      sayCommand(QUEST_NPC_COMMAND);
      this.commandSent = true;
      this.nextStepAt = 0;
      log(`排队 ${QUEST_NPC_COMMAND}`);
      return TaskResult.RUNNING;
    }
    if (this.nextStepAt === 0 || Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    return this.fail(`${QUEST_LIST_TITLE} 没有打开`);
  }

  private clickEntry(context: HunterContext): string {
    const inv = openContainer();
    if (!inv) {
      if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
      return this.fail("任务界面关了");
    }
    if (!this.entryClicked) {
      if (this.mode === "accept" && !this.followingTurnIn && slotHasQuest(QUEST_TURNIN_SLOT)) {
        return this.stopAccept(context, `第 ${QUEST_TURNIN_SLOT} 格已经是${ACTIVE_QUEST_NAME}，不再接取`);
      }
      const slot = this.mode === "turnin" ? QUEST_TURNIN_SLOT : QUEST_ACCEPT_SLOT;
      inv.click(slot, 0);
      log(`${this.mode === "turnin" ? "交付" : "接取"}点击第 ${slot} 格`);
      this.entryClicked = true;
      this.nextStepAt = Date.now() + CLICK_WAIT_MS;
      this.phase = "wait-detail";
    }
    return TaskResult.RUNNING;
  }

  private waitForDetail(): string {
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    if (!openContainer()) return this.fail("任务详情没有打开");
    this.phase = "click-confirm";
    this.confirmClicked = false;
    return TaskResult.RUNNING;
  }

  private clickConfirm(context: HunterContext): string {
    if (!this.confirmClicked) {
      if (!openContainer()) return this.fail("确认前界面关了");
      openContainer()?.click(QUEST_CONFIRM_SLOT, 0);
      log(`点击确认第 ${QUEST_CONFIRM_SLOT} 格`);
      this.confirmClicked = true;
      this.nextStepAt = Date.now() + 2_000;
      return TaskResult.RUNNING;
    }
    if (this.mode === "turnin") {
      if (containerTitle() && Date.now() < this.nextStepAt) return TaskResult.RUNNING;
      return this.finishTurnIn(context);
    }
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    return this.fail("没有看到接取成功");
  }

  private finishTurnIn(context: HunterContext): string {
    log("任务已交付，重新接取");
    this.releasePointer();
    closeContainer();
    context.questComplete = false;
    context.clearForQuest = false;
    context.questTurnInReady = false;
    context.questProgress = -1;
    context.questSawPartial = false;
    context.questIgnoreUntil = Date.now() + 2_000;
    context.questActive = true;
    this.mode = "accept";
    this.followingTurnIn = true;
    this.acceptBaseline = context.questAcceptSeenAt;
    this.phase = "open";
    this.commandSent = false;
    this.entryClicked = false;
    this.confirmClicked = false;
    this.nextStepAt = 0;
    return TaskResult.RUNNING;
  }

  private finishAccept(context: HunterContext): string {
    this.releasePointer();
    closeContainer();
    selectHotbar(SWORD_HOTBAR);
    context.questActive = true;
    context.questComplete = false;
    context.clearForQuest = false;
    context.questTurnInReady = false;
    context.questProgress = -1;
    context.questSawPartial = false;
    context.questAcceptedAt = Date.now();
    context.questIgnoreUntil = Date.now() + 2_000;
    this.engaged = false;
    this.followingTurnIn = false;
    this.acceptBaseline = context.questAcceptSeenAt;
    this.phase = "idle";
    log("已接取任务，升级先不读");
    return TaskResult.RUNNING;
  }

  private fail(message: string): string {
    log(message);
    this.releasePointer();
    closeContainer();
    this.phase = "retry";
    this.commandSent = false;
    this.entryClicked = false;
    this.confirmClicked = false;
    this.nextStepAt = Date.now() + 4_000;
    return TaskResult.RUNNING;
  }

  private retry(context: HunterContext): string {
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    this.phase = "open";
    this.commandSent = false;
    return this.openMenu();
  }
}

/** 从聊天里读 EliteMobs 击杀任务进度。没有这条消息时返回 null。 */
export function readQuestProgress(text: string): { current: number; total: number } | null {
  const plain = plainText(text);
  if (!plain.includes("EliteMobs") || !plain.includes("击杀")) return null;
  const matches = [...plain.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total };
}

/**
 * 聊天里的接取和放弃。
 * 接取成功后面板会马上关掉，不能靠界面还在不在来判断。
 */
export function noteQuestStatus(context: HunterContext, text: string): void {
  const plain = plainText(text);
  if (plain.includes("你已接受任务") || plain.includes("正在追踪一个任务")) {
    context.questActive = true;
    context.questComplete = false;
    context.clearForQuest = false;
    context.questTurnInReady = false;
    context.questAcceptSeenAt = Date.now();
    if (context.questAcceptedAt === 0) context.questAcceptedAt = context.questAcceptSeenAt;
    context.questIgnoreUntil = Math.max(context.questIgnoreUntil, context.questAcceptSeenAt + 2_000);
    log("任务已接上，停止重复接取");
    return;
  }
  if (!plain.includes("你已放弃任务")) return;
  context.questActive = false;
  context.questAcceptedAt = 0;
  context.questSawPartial = false;
  context.questProgress = -1;
  context.questIgnoreUntil = Date.now() + 2_000;
  log("任务被放弃了，重新接取");
}

/**
 * 记下聊天里的任务进度。
 * 返回 true 表示这一条刚把任务打满，调用方要打断当前操作。
 */
export function noteQuestChat(context: HunterContext, text: string): boolean {
  const progress = readQuestProgress(text);
  if (!progress) return false;
  if (Date.now() < context.questIgnoreUntil) return false;
  const { current, total } = progress;
  context.questTotal = total;
  if (current < total) {
    if (context.questProgress !== current) {
      context.questProgress = current;
      log(`任务进度 ${current} / ${total}`);
    }
    context.questSawPartial = true;
    context.questActive = true;
    return false;
  }
  if (context.questAcceptedAt > 0 && !context.questSawPartial) return false;
  if (context.questComplete || context.clearForQuest || context.questTurnInReady) return false;
  context.questProgress = current;
  context.questComplete = true;
  context.questActive = true;
  log(`任务完成 ${current} / ${total}`);
  return true;
}

function slotHasQuest(slot: number): boolean {
  const inv = openContainer();
  if (!inv) return false;
  const item = inv.getSlot(slot);
  if (item.isEmpty()) return false;
  const name = plainText(item.getName()?.getString() ?? "");
  const lore = toArray(item.getLore())
    .map((line) => plainText(line.getString()))
    .join("\n");
  return `${name}\n${lore}`.includes(ACTIVE_QUEST_NAME);
}

let reportedScreen = "";

function noteOpenedScreen(): void {
  const title = containerTitle() || Hud.getOpenScreenName() || "容器";
  if (reportedScreen === title) return;
  reportedScreen = title;
  log(`打开的界面是 ${title}`);
}
