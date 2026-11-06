import { Task, TaskResult } from "../../util/scheduler.ts";
import {
  canDoFieldWork,
  closeContainer,
  consumeSentCommand,
  log,
  openContainer,
  sayCommand,
  selectHotbar,
  stopPathing,
  toArray,
  upgradePaused,
  type HunterContext,
} from "../actions.ts";
import { AG_COMMAND, SWORD_HOTBAR, TaskPriority } from "../config.ts";
import { amountIn, formatCoins } from "../coins.ts";
import { plainText } from "../login.ts";

type UpgradePhase = "idle" | "command" | "wait" | "read" | "click" | "reread";

export class UpgradeTask extends Task {
  private phase: UpgradePhase = "idle";
  private commandSent = false;
  private clickUpgrade = false;
  private nextStepAt = 0;
  private reopened = false;

  constructor() {
    super("upgrade", TaskPriority.upgrade);
  }

  shouldRun(context: HunterContext): boolean {
    if (context.needsAuthLogin || !canDoFieldWork(context)) return false;
    const reading = context.upgradeCost == null;
    const turningIn = context.clearForQuest || context.questTurnInReady || context.questComplete;
    if ((upgradePaused(context) && !reading) || (reading && turningIn)) {
      if (this.phase !== "idle") {
        this.phase = "idle";
        this.clickUpgrade = false;
        closeContainer();
      }
      return false;
    }
    if (this.phase !== "idle") return true;
    if (reading) return Date.now() >= context.upgradeHoldUntil;
    return context.upgradeReady;
  }

  start(context: HunterContext): void {
    this.begin(context.upgradeReady);
  }

  resume(context: HunterContext): void {
    this.begin(context.upgradeReady);
  }

  suspend(): void {
    stopPathing();
    closeContainer();
  }

  abort(): void {
    this.phase = "idle";
    this.suspend();
  }

  tick(context: HunterContext): string {
    if (this.phase === "command") return this.sendCommand();
    if (this.phase === "wait") return this.waitForPanel(context);
    if (this.phase === "read") return this.readPanel(context);
    if (this.phase === "click") return this.clickAndWait(context);
    if (this.phase === "reread") return this.readAgain(context);
    this.phase = "command";
    return TaskResult.RUNNING;
  }

  private begin(clickUpgrade: boolean): void {
    stopPathing();
    closeContainer();
    this.clickUpgrade = clickUpgrade;
    this.commandSent = false;
    this.reopened = false;
    this.phase = "command";
    log(clickUpgrade ? "打开 /ag，点击升级" : "先打开 /ag，查看升级需要的精英币");
    if (clickUpgrade) Chat.log("[hunter] 余额够了，打开 /ag 点击升级");
  }

  private sendCommand(): string {
    if (!this.commandSent) {
      sayCommand(AG_COMMAND);
      this.commandSent = true;
      this.nextStepAt = 0;
      return TaskResult.RUNNING;
    }
    if (consumeSentCommand() !== AG_COMMAND) return TaskResult.RUNNING;
    this.phase = "wait";
    this.nextStepAt = Date.now() + 6_000;
    return TaskResult.RUNNING;
  }

  private waitForPanel(context: HunterContext): string {
    if (openContainer()) {
      this.phase = this.clickUpgrade && this.reopened ? "reread" : "read";
      return TaskResult.RUNNING;
    }
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    Chat.log("[hunter] /ag 没有打开面板，30 秒后再看升级花费");
    this.finishWithoutClick(context);
    return TaskResult.RUNNING;
  }

  private readPanel(context: HunterContext): string {
    const inv = openContainer();
    if (!inv) {
      this.finishWithoutClick(context);
      return TaskResult.RUNNING;
    }
    const panel = describePanel(inv);
    rememberPanelWallet(context, panel.wallet);
    const offer = panel.offer;
    if (!offer) {
      Chat.log(`[hunter] /ag 没解析到升级花费：${panel.sample || "面板是空的"}`);
      closeContainer();
      this.finishWithoutClick(context);
      return TaskResult.RUNNING;
    }
    context.upgradeCost = offer.cost;
    context.upgradeKnown = true;
    Chat.log(`[hunter] 升级需要 ${formatCoins(offer.cost)} 精英币（第 ${offer.slot} 格 ${offer.name}）`);
    log(`升级需要 ${formatCoins(offer.cost)} 精英币，按钮在第 ${offer.slot} 格：${offer.name}`);
    if (!this.clickUpgrade) {
      closeContainer();
      selectHotbar(SWORD_HOTBAR);
      this.phase = "idle";
      return TaskResult.RUNNING;
    }
    inv.click(offer.slot, 0);
    log(`点击升级第 ${offer.slot} 格`);
    this.phase = "click";
    this.nextStepAt = Date.now() + 1_000;
    return TaskResult.RUNNING;
  }

  private clickAndWait(context: HunterContext): string {
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    if (openContainer()) {
      this.phase = "reread";
      return TaskResult.RUNNING;
    }
    if (this.reopened) {
      log("升级后没有再次打开面板");
      this.finishWithoutClick(context);
      return TaskResult.RUNNING;
    }
    this.reopened = true;
    this.commandSent = false;
    this.phase = "command";
    log("升级后面板关了，重新打开 /ag 读取下一级");
    return TaskResult.RUNNING;
  }

  private readAgain(context: HunterContext): string {
    const inv = openContainer();
    if (!inv) {
      this.phase = "click";
      return TaskResult.RUNNING;
    }
    const panel = describePanel(inv);
    rememberPanelWallet(context, panel.wallet);
    const offer = panel.offer;
    closeContainer();
    selectHotbar(SWORD_HOTBAR);
    context.upgradeReady = false;
    this.phase = "idle";
    if (!offer) {
      context.upgradeHoldUntil = Date.now() + 60_000;
      Chat.log("[hunter] 升级后没读到新的花费，60 秒后再看");
      return TaskResult.RUNNING;
    }
    context.upgradeCost = offer.cost;
    context.upgradeKnown = true;
    log(`下一次升级需要 ${formatCoins(offer.cost)} 精英币`);
    return TaskResult.RUNNING;
  }

  private finishWithoutClick(context: HunterContext): void {
    const wasClick = this.clickUpgrade;
    closeContainer();
    selectHotbar(SWORD_HOTBAR);
    this.phase = "idle";
    context.upgradeReady = false;
    this.clickUpgrade = false;
    if (context.upgradeCost == null) {
      context.upgradeKnown = false;
      context.upgradeHoldUntil = Date.now() + 30_000;
      return;
    }
    context.upgradeKnown = true;
    if (wasClick) context.upgradeHoldUntil = Date.now() + 60_000;
  }
}

type UpgradeOffer = { slot: number; cost: number; name: string };
type PanelReading = { offer: UpgradeOffer | null; wallet: number | null; sample: string };

function describePanel(inv: NonNullable<ReturnType<typeof Player.openInventory>>): PanelReading {
  let slots = toArray(inv.getSlots("container"));
  if (slots.length === 0) {
    slots = [];
    for (let index = 0; index < inv.getTotalSlots(); index += 1) slots.push(index);
  }
  const marked: UpgradeOffer[] = [];
  const costs: UpgradeOffer[] = [];
  const sample: string[] = [];
  let wallet: number | null = null;
  for (const slot of slots) {
    const item = inv.getSlot(slot);
    if (item.isEmpty()) continue;
    const name = plainText(item.getName()?.getString() ?? "");
    const loreLines = toArray(item.getLore()).map((line) => plainText(line.getString()));
    const lore = loreLines.join("\n");
    if (sample.length < 6) sample.push(`${slot} ${name} ${loreLines[0] ?? ""}`.slice(0, 60));
    const owned = lore.match(/你有\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*万)?\s*精英币/);
    if (owned) wallet = owned[0].includes("万") ? Number(owned[1].replace(/,/g, "")) * 10_000 : Number(owned[1].replace(/,/g, ""));
    const cost = costIn(lore);
    if (cost == null) continue;
    const offer = { slot, cost, name };
    costs.push(offer);
    if (lore.includes("下一个") || lore.includes("解锁")) marked.push(offer);
  }
  const offer = marked.length === 1 ? marked[0] : marked.length === 0 && costs.length === 1 ? costs[0] : null;
  return { offer, wallet, sample: sample.join("；") };
}

function costIn(lore: string): number | null {
  const line = lore.split("\n").find((row) => row.includes("需要") && row.includes("精英币"));
  if (!line) return null;
  return amountIn(line.slice(line.indexOf("需要")));
}

function rememberPanelWallet(context: HunterContext, wallet: number | null): void {
  if (wallet == null || context.wallet != null) return;
  context.wallet = wallet;
  if (context.baselineWallet == null) context.baselineWallet = wallet;
  log(`余额命令还没有读到，先用面板上的 ${formatCoins(wallet)} 精英币`);
}
