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
  OPEN_QUEST_ITEM,
  QUEST_CONFIRM_SLOT,
  QUEST_LIST_TITLE,
  QUEST_NPC_COMMAND,
  QUEST_HOLD_PROGRESS,
  QUEST_TURNIN_SLOT,
  SWORD_HOTBAR,
  TaskPriority,
  questRoutes,
  routeAt,
  type QuestRoute,
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
  private dumpedPanel = false;
  /** 点过放弃之后先重新打开，确认那张任务已经不在面板上。 */
  private confirmDropped = false;
  private droppedRoute: QuestRoute | null = null;

  constructor() {
    super("quest", TaskPriority.quest);
  }

  shouldRun(context: HunterContext): boolean {
    if (!canDoFieldWork(context)) return false;
    if (context.clearForQuest && !context.questTurnInReady && !context.abandonQuest) return false;
    if (this.engaged) return true;
    if (context.questTurnInReady || context.abandonQuest) return true;
    return !context.questActive && !context.questComplete;
  }

  start(context: HunterContext): void {
    this.engaged = true;
    if (context.questTurnInReady || context.abandonQuest) {
      this.mode = "turnin";
      this.followingTurnIn = false;
    } else if (!this.followingTurnIn) this.mode = "accept";
    log(this.mode === "turnin" ? (context.abandonQuest ? "放弃任务" : "交付任务") : "接取任务");
    this.acceptBaseline = context.questAcceptSeenAt;
    context.questMenuBusy = true;
    this.begin();
  }

  resume(context: HunterContext): void {
    this.engaged = true;
    if (context.questTurnInReady || context.abandonQuest) {
      this.mode = "turnin";
      this.followingTurnIn = false;
    } else if (!this.followingTurnIn) this.mode = "accept";
    log(this.mode === "turnin" ? (context.abandonQuest ? "继续放弃任务" : "继续交付任务") : "继续接取任务");
    this.acceptBaseline = context.questAcceptSeenAt;
    context.questMenuBusy = true;
    this.begin();
  }

  suspend(): void {
    this.releasePointer();
    stopPathing();
    closeContainer();
  }

  abort(context?: HunterContext): void {
    if (context) context.questMenuBusy = false;
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
    if (this.phase === "wait-detail") return this.waitForDetail(context);
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
    this.dumpedPanel = false;
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
    context.questMenuBusy = false;
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
      if (!this.dumpedPanel) {
        this.dumpedPanel = true;
        dumpQuestPanel(this.mode);
      }
      if (this.confirmDropped) {
        this.confirmDropped = false;
        if (takenQuestSlot() == null) return this.finishTurnIn(context);
        this.mode = "turnin";
        Chat.log("[hunter] 任务还在面板上，继续放弃");
      }
      if (this.mode === "accept") {
        const active = activeQuestPane();
        if (active) {
          const listed = listedQuest();
          if (this.followingTurnIn) {
            this.mode = "turnin";
            if (listed) this.droppedRoute = listed;
            Chat.log(`[hunter] ${listed?.name ?? active.name} 还没放弃掉，继续点第 ${active.slot} 格`);
          } else {
            if (listed) {
              context.questName = listed.name;
              context.routeIndex = Math.max(0, questRoutes.findIndex((route) => route.name === listed.name));
            }
            context.farmName = "";
            context.revisitQuestAt = 0;
            Chat.log(
              `[hunter] 已有任务 ${listed?.name ?? active.name}，在第 ${active.slot} 格，不再接取`,
            );
            return this.stopAccept(context, `已有任务 ${listed?.name ?? active.name}`);
          }
        }
      }
      if (this.mode === "turnin" && takenQuestSlot() == null) {
        this.mode = "accept";
        this.followingTurnIn = true;
        Chat.log(`[hunter] 任务已经不在面板上，改为接取 ${routeAt(context.routeIndex).name}`);
      }
      const route = routeAt(context.routeIndex);
      const slot = this.mode === "turnin" ? takenQuestSlot() : paneSlot(OPEN_QUEST_ITEM, route.name);
      if (slot == null) {
        return this.fail(
          this.mode === "turnin" ? "面板里没有已接任务，取消放弃或交付" : `没有找到可接的 ${route.name}`,
        );
      }
      if (this.mode === "turnin") this.droppedRoute = listedQuest();
      inv.click(slot, 0);
      const action = this.mode === "turnin" ? (context.abandonQuest ? "放弃" : "交付") : "接取";
      const target = this.mode === "turnin" ? "已接任务" : route.name;
      Chat.log(`[hunter] ${action} ${target}，点第 ${slot} 格`);
      this.entryClicked = true;
      this.nextStepAt = Date.now() + CLICK_WAIT_MS;
      this.phase = "wait-detail";
    }
    return TaskResult.RUNNING;
  }

  private waitForDetail(context: HunterContext): string {
    if (!openContainer() && this.mode === "turnin") {
      this.confirmDropped = true;
      this.phase = "open";
      this.commandSent = false;
      this.entryClicked = false;
      this.dumpedPanel = false;
      return TaskResult.RUNNING;
    }
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
    const abandoning = context.abandonQuest;
    const dropped = this.droppedRoute;
    this.droppedRoute = null;
    const droppedIndex = dropped ? questRoutes.findIndex((route) => route.name === dropped.name) : -1;
    const base = droppedIndex >= 0 ? droppedIndex : context.routeIndex;
    const previous = dropped?.name ?? (context.questName || routeAt(base).name);
    context.abandonQuest = false;
    context.routeIndex = (base + 1) % questRoutes.length;
    context.questName = routeAt(context.routeIndex).name;
    context.farmName = "";
    context.revisitQuestAt = 0;
    if (abandoning) Chat.log(`[hunter] 放弃 ${previous}，接下一个 ${context.questName}`);
    else if (questRoutes.length > 1) Chat.log(`[hunter] 任务已交付，下一张接 ${context.questName}`);
    else log(`任务已交付，重新接取 ${context.questName}`);
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
    context.questMenuBusy = false;
    if (!questRoutes.some((route) => route.name === context.questName)) {
      context.questName = routeAt(context.routeIndex).name;
    }
    context.farmName = "";
    context.revisitQuestAt = 0;
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

/** 从聊天里读 EliteMobs 任务进度。没有这条消息时返回 null。 */
export function readQuestProgress(text: string, questName = ""): { current: number; total: number } | null {
  const plain = plainText(text).replace(/／/g, "/");
  const aboutQuest =
    plain.includes("击杀") ||
    plain.includes("消灭") ||
    plain.includes("击败") ||
    (questName !== "" && plain.includes(questName));
  if (!plain.includes("EliteMobs") || !aboutQuest) return null;
  const matches = [...plain.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total };
}

function explicitComplete(text: string, questName: string): boolean {
  if (questName === "" || !text.includes(questName)) return false;
  return text.includes("已完成") || text.includes("完成了") || text.includes("任务完成");
}

/**
 * 聊天里的接取和放弃。
 * 接取成功后面板会马上关掉，不能靠界面还在不在来判断。
 */
export function noteQuestStatus(context: HunterContext, text: string): void {
  const plain = plainText(text);
  if (plain.includes("你已接受任务") || plain.includes("正在追踪一个任务")) {
    if (bindNamedQuest(context, plain)) Chat.log(`[hunter] 当前任务 ${context.questName}`);
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
  context.questName = "";
  context.farmName = "";
  context.revisitQuestAt = 0;
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
  const plain = plainText(text).replace(/／/g, "/");
  if (Date.now() < context.questIgnoreUntil) return false;
  const mentioned = questRoutes.find((route) => plain.includes(route.name));
  if (mentioned) {
    context.questName = mentioned.name;
    context.routeIndex = Math.max(0, questRoutes.findIndex((route) => route.name === mentioned.name));
  }
  if (explicitComplete(plain, context.questName)) {
    return markQuestComplete(context, Math.max(context.questProgress, 1), Math.max(context.questTotal, 1));
  }
  const progress = readQuestProgress(plain, context.questName);
  if (!progress) return false;
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
  const named = context.questName !== "" && plain.includes(context.questName);
  const singleTarget = total <= 1;
  if (context.questAcceptedAt > 0 && !context.questSawPartial && !named && !singleTarget) return false;
  return markQuestComplete(context, current, total);
}

function markQuestComplete(context: HunterContext, current: number, total: number): boolean {
  if (context.questComplete || context.clearForQuest || context.questTurnInReady) return false;
  context.questProgress = current;
  context.questTotal = total;
  context.questComplete = true;
  context.questActive = true;
  Chat.log(`[hunter] 任务完成 ${current} / ${total}`);
  return !context.questMenuBusy;
}

function itemId(item: ItemStackHelper): string {
  return String(item.getItemId() ?? "").replace(/^minecraft:/, "");
}

function containerSlots(inv: NonNullable<ReturnType<typeof Player.openInventory>>): number[] {
  const mapped = toArray(inv.getSlots("container"));
  if (mapped.length > 0) return mapped;
  const total = Math.min(inv.getTotalSlots(), 54);
  const slots: number[] = [];
  for (let index = 0; index < total; index += 1) slots.push(index);
  return slots;
}

function takenQuestSlot(): number | null {
  const inv = openContainer();
  if (!inv) return null;
  for (const slot of containerSlots(inv)) {
    const stack = inv.getSlot(slot);
    if (stack.isEmpty()) continue;
    const id = itemId(stack);
    if (id.includes("stained_glass_pane") && !id.includes(OPEN_QUEST_ITEM)) return slot;
  }
  return null;
}

function activeQuestPane(): { slot: number; name: string } | null {
  const inv = openContainer();
  const slot = takenQuestSlot();
  if (!inv || slot == null) return null;
  const item = inv.getSlot(slot);
  if (item.isEmpty()) return null;
  return { slot, name: plainText(item.getName()?.getString() ?? "") || "已接任务" };
}

function paneSlot(item: string, questName = ""): number | null {
  const inv = openContainer();
  if (!inv) return null;
  for (const slot of containerSlots(inv)) {
    const stack = inv.getSlot(slot);
    if (stack.isEmpty() || !itemId(stack).includes(item)) continue;
    if (questName === "") return slot;
    const name = plainText(stack.getName()?.getString() ?? "");
    const lore = toArray(stack.getLore())
      .map((line) => plainText(line.getString()))
      .join("\n");
    if (`${name}\n${lore}`.includes(questName)) return slot;
  }
  return null;
}

function dumpQuestPanel(mode: string): void {
  const inv = openContainer();
  if (!inv) return;
  const rows: string[] = [];
  for (const slot of containerSlots(inv)) {
    const item = inv.getSlot(slot);
    if (item.isEmpty()) continue;
    const name = plainText(item.getName()?.getString() ?? "");
    rows.push(`${slot}:${itemId(item)}:${name}`);
  }
  Chat.log(`[hunter] 任务面板(${mode}) ${containerTitle() || "无标题"}`);
  for (let index = 0; index < rows.length; index += 4) {
    Chat.log(`[hunter] ${rows.slice(index, index + 4).join(" | ")}`);
  }
  if (rows.length === 0) Chat.log("[hunter] 任务面板是空的");
}

function bindNamedQuest(context: HunterContext, text: string): boolean {
  const matches = questRoutes.filter((route) => text.includes(route.name));
  matches.sort((a, b) => b.name.length - a.name.length);
  const route = matches[0];
  if (!route) return false;
  context.questName = route.name;
  context.routeIndex = Math.max(0, questRoutes.findIndex((item) => item.name === route.name));
  context.farmName = "";
  context.revisitQuestAt = 0;
  return true;
}

function listedQuest(): QuestRoute | null {
  const inv = openContainer();
  const slot = takenQuestSlot();
  if (!inv || slot == null) return null;
  const item = inv.getSlot(slot);
  if (item.isEmpty()) return null;
  const name = plainText(item.getName()?.getString() ?? "");
  const lore = toArray(item.getLore())
    .map((line) => plainText(line.getString()))
    .join("\n");
  const text = `${name}\n${lore}`;
  return questRoutes.find((route) => text.includes(route.name)) ?? null;
}

/** 这一轮家里都没有怪。进度还没到八成就放弃并换下一张，操作和交付一样。 */
export function noteRouteDry(context: HunterContext, farmedName: string): void {
  if (context.abandonQuest || context.questTurnInReady || context.questComplete || context.clearForQuest) return;
  const known = context.questProgress >= 0 && context.questTotal > 0;
  const ratio = known ? context.questProgress / context.questTotal : 0;
  const current = known ? `${context.questProgress} / ${context.questTotal}` : "进度未知";
  if (ratio >= QUEST_HOLD_PROGRESS) {
    Chat.log(`[hunter] ${farmedName || "当前任务"} 这轮没怪，进度 ${current} 快完成了，继续等`);
    return;
  }
  context.farmName = "";
  context.revisitQuestAt = 0;
  context.abandonQuest = true;
  Chat.log(`[hunter] ${farmedName || "当前任务"} 这轮没怪，进度 ${current}，放弃并换下一张`);
}

let reportedScreen = "";

function noteOpenedScreen(): void {
  const title = containerTitle() || Hud.getOpenScreenName() || "容器";
  if (reportedScreen === title) return;
  reportedScreen = title;
  log(`打开的界面是 ${title}`);
}
