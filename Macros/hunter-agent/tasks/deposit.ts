import { Task, TaskResult } from "../../util/scheduler.ts";
import {
  canDoFieldWork,
  closeContainer,
  consumeSentCommand,
  containerTitle,
  isInventoryFull,
  log,
  playerPosition,
  sayCommand,
  selectHotbar,
  stopPathing,
  stopSteering,
  teleportProgress,
  toArray,
  tryUseHome,
  type HunterContext,
  type Vec3,
} from "../actions.ts";
import {
  SELL_BATCH,
  SHOP_CATEGORY_SLOT,
  SHOP_COMMAND,
  SHOP_CONFIRM_SLOT,
  SWORD_HOTBAR,
  TERMINAL_HOLD_MS,
  TERMINAL_HOTBAR,
  TERMINAL_LOAD_MS,
  TERMINAL_SYNC_MS,
  TaskPriority,
  baseHome,
  keepItemNames,
} from "../config.ts";
import { plainText } from "../login.ts";

type DepositPhase =
  | "home"
  | "arrive"
  | "shop"
  | "wait-shop"
  | "category"
  | "wait-sell"
  | "sell"
  | "confirm"
  | "terminal"
  | "wait-terminal"
  | "store"
  | "finish"
  | "retry";

type SellStage = "move" | "confirm" | "move-rest" | "confirm-rest";

export class DepositTask extends Task {
  private active = false;
  private phase: DepositPhase = "home";
  private depart: Vec3 | null = null;
  private departAt = 0;
  private nextStepAt = 0;
  private shopCommandSent = false;
  private categoryClicked = false;
  private sellSlots: number[] = [];
  private storeSlots: number[] = [];
  private sellIndex = 0;
  private sellStage: SellStage = "move";
  private handCleared = false;
  private moveRetried = false;
  private hotbarSelected = false;
  private useHeld = false;
  private swordSelected = false;
  private storeAfter = 0;
  private terminalReadyAt = 0;
  private loggedTerminalWait = false;

  constructor() {
    super("deposit", TaskPriority.deposit);
  }

  shouldRun(context: HunterContext): boolean {
    if (!canDoFieldWork(context)) return false;
    if (this.active) return true;
    return context.depositForUpgrade || context.clearForQuest || isInventoryFull();
  }

  start(context: HunterContext): void {
    this.active = true;
    log(depositReason(context));
    this.restart();
  }

  resume(context: HunterContext): void {
    if (!isInventoryFull() && !context.clearForQuest && !context.depositForUpgrade) {
      this.active = false;
      this.phase = "home";
      stopPathing();
      closeContainer();
      return;
    }
    this.active = true;
    this.restart();
  }

  suspend(): void {
    stopPathing();
    closeContainer();
    releaseUse();
  }

  abort(): void {
    this.active = false;
    this.suspend();
  }

  tick(context: HunterContext): string {
    if (!this.active) return TaskResult.RUNNING;
    if (this.phase === "home") return this.goHome(context);
    if (this.phase === "arrive") return this.waitArrival();
    if (this.phase === "shop") return this.openShop();
    if (this.phase === "wait-shop") return this.waitForTitle("购买或出售", "category");
    if (this.phase === "category") return this.clickCategory();
    if (this.phase === "wait-sell") return this.waitForSellShop();
    if (this.phase === "sell") return this.sellItems();
    if (this.phase === "confirm") return this.confirmSale();
    if (this.phase === "terminal") return this.openTerminal();
    if (this.phase === "wait-terminal") return this.waitForTitle("ME综合终端", "store");
    if (this.phase === "store") return this.storeItems();
    if (this.phase === "finish") return this.done(context);
    return this.retry(context);
  }

  private restart(): void {
    stopPathing();
    closeContainer();
    this.phase = "home";
    this.depart = null;
    this.shopCommandSent = false;
    this.categoryClicked = false;
    this.sellSlots = [];
    this.storeSlots = [];
    this.sellIndex = 0;
    this.sellStage = "move";
    this.handCleared = false;
    this.moveRetried = false;
    this.hotbarSelected = false;
    this.useHeld = false;
    this.swordSelected = false;
    this.storeAfter = 0;
    releaseUse();
  }

  private fail(message: string): string {
    log(message);
    closeContainer();
    releaseUse();
    this.phase = "retry";
    this.nextStepAt = Date.now() + 8_000;
    return TaskResult.RUNNING;
  }

  private goHome(context: HunterContext): string {
    if (!tryUseHome(context, baseHome)) return TaskResult.RUNNING;
    this.depart = playerPosition();
    this.departAt = Date.now();
    this.phase = "arrive";
    return TaskResult.RUNNING;
  }

  private waitArrival(): string {
    const progress = teleportProgress(this.depart, this.departAt);
    if (progress === "moving") return TaskResult.RUNNING;
    if (progress === "missed") {
      closeContainer();
      releaseUse();
      stopSteering();
      this.phase = "home";
      this.shopCommandSent = false;
      log("传送没有生效，重新传送");
      return TaskResult.RUNNING;
    }
    this.phase = "shop";
    this.shopCommandSent = false;
    log("已到家，打开出售商店");
    return TaskResult.RUNNING;
  }

  private openShop(): string {
    if (!this.shopCommandSent) {
      sayCommand(SHOP_COMMAND);
      this.shopCommandSent = true;
      this.nextStepAt = 0;
      return TaskResult.RUNNING;
    }
    if (consumeSentCommand() !== SHOP_COMMAND) return TaskResult.RUNNING;
    this.phase = "wait-shop";
    this.nextStepAt = Date.now() + 6_000;
    return TaskResult.RUNNING;
  }

  private waitForTitle(title: string, next: DepositPhase): string {
    if (containerTitle().includes(title)) {
      log(`界面已打开：${containerTitle()}`);
      this.phase = next;
      this.nextStepAt = 0;
      return TaskResult.RUNNING;
    }
    if (Date.now() >= this.nextStepAt) return this.fail(`${title}没有打开`);
    return TaskResult.RUNNING;
  }

  private clickCategory(): string {
    if (!this.categoryClicked) {
      Player.openInventory()?.click(SHOP_CATEGORY_SLOT, 0);
      log(`点击商店第 ${SHOP_CATEGORY_SLOT} 格`);
      this.categoryClicked = true;
      this.nextStepAt = Date.now() + 1_000;
      return TaskResult.RUNNING;
    }
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    this.phase = "wait-sell";
    this.nextStepAt = Date.now() + 6_000;
    return TaskResult.RUNNING;
  }

  private waitForSellShop(): string {
    if (!containerTitle().includes("出售商店")) {
      if (Date.now() >= this.nextStepAt) return this.fail("出售商店打开失败");
      return TaskResult.RUNNING;
    }
    this.collectSlots();
    log(`可出售 ${this.sellSlots.length} 个，待存储 ${this.storeSlots.length} 个`);
    this.sellIndex = 0;
    this.sellStage = "move";
    this.phase = this.sellSlots.length > 0 ? "sell" : "terminal";
    if (this.phase === "terminal") this.beginTerminalWait();
    this.handCleared = false;
    this.moveRetried = false;
    this.hotbarSelected = false;
    this.useHeld = false;
    this.swordSelected = false;
    return TaskResult.RUNNING;
  }

  private sellItems(): string {
    if (!containerTitle().includes("出售商店")) return this.fail("出售商店关了");
    if (this.sellStage === "move-rest" && Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    const batchEnd =
      this.sellStage === "move"
        ? Math.min(SELL_BATCH, this.sellSlots.length)
        : this.sellSlots.length;
    if (this.sellIndex < batchEnd) {
      Player.openInventory()?.quick(this.sellSlots[this.sellIndex]);
      this.sellIndex += 1;
      return TaskResult.RUNNING;
    }
    this.phase = "confirm";
    this.nextStepAt = Date.now() + 200;
    return TaskResult.RUNNING;
  }

  private confirmSale(): string {
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    Player.openInventory()?.click(SHOP_CONFIRM_SLOT, 0);
    log("确认出售");
    if (this.sellStage === "move" && this.sellSlots.length > SELL_BATCH) {
      this.sellStage = "move-rest";
      this.phase = "sell";
      this.nextStepAt = Date.now() + 1_000;
      return TaskResult.RUNNING;
    }
    closeContainer();
    this.phase = "terminal";
    this.beginTerminalWait();
    this.handCleared = false;
    this.moveRetried = false;
    this.hotbarSelected = false;
    this.useHeld = false;
    this.swordSelected = false;
    this.sellIndex = 0;
    return TaskResult.RUNNING;
  }

  private beginTerminalWait(): void {
    this.terminalReadyAt = Date.now() + TERMINAL_LOAD_MS;
    this.loggedTerminalWait = false;
  }

  private openTerminal(): string {
    if (Date.now() < this.terminalReadyAt) {
      if (!this.loggedTerminalWait) {
        this.loggedTerminalWait = true;
        log("等 5 秒，让终端区块加载");
      }
      return TaskResult.RUNNING;
    }
    if (this.storeSlots.length === 0) {
      log("没有需要存储的物品");
      selectHotbar(SWORD_HOTBAR);
      this.phase = "finish";
      this.nextStepAt = 0;
      return TaskResult.RUNNING;
    }
    if (!this.handCleared) {
      if (containerTitle()) {
        closeContainer();
        this.nextStepAt = Date.now() + 400;
        return TaskResult.RUNNING;
      }
      if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
      const inv = Player.openInventory();
      if (!inv) return this.fail("打不开背包");
      if (Hud.getOpenScreenName() !== "Survival Inventory") {
        inv.openGui();
        this.nextStepAt = Date.now() + 200;
        return TaskResult.RUNNING;
      }
      const slot = hotbarSlot(TERMINAL_HOTBAR);
      if (slot !== null && !inv.getSlot(slot).isEmpty()) {
        const name = slotName(inv, slot);
        inv.quick(slot);
        log(`把快捷栏 2 的 ${name} 移到背包`);
      } else {
        log("快捷栏 2 已经是空的");
      }
      this.handCleared = true;
      this.nextStepAt = Date.now() + 300;
      return TaskResult.RUNNING;
    }
    if (!this.hotbarSelected) {
      if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
      const inv = Player.openInventory();
      const slot = hotbarSlot(TERMINAL_HOTBAR);
      if (!inv || slot === null || !inv.getSlot(slot).isEmpty()) {
        if (inv && slot !== null && !this.moveRetried && Hud.getOpenScreenName() === "Survival Inventory") {
          const name = slotName(inv, slot);
          const free = inv.findFreeSlot("main");
          if (free >= 0) {
            inv.click(slot, 0);
            inv.click(free, 0);
            this.moveRetried = true;
            this.nextStepAt = Date.now() + 300;
            log(`快捷栏 2 的 ${name} 还在，改放到背包空格`);
            return TaskResult.RUNNING;
          }
        }
        const name = inv && slot !== null ? slotName(inv, slot) : "物品";
        Player.openInventory()?.close();
        return this.fail(`快捷栏 2 还有 ${name}，取消点击终端`);
      }
      Player.openInventory()?.close();
      selectHotbar(TERMINAL_HOTBAR);
      log("空手切换到快捷栏 2");
      this.hotbarSelected = true;
      this.useHeld = false;
      this.nextStepAt = Date.now() + 200;
      return TaskResult.RUNNING;
    }
    if (!this.useHeld) {
      if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
      const hit = Player.detailedRayTraceBlock(5, false);
      const blockPos = hit && !hit.isMissed() ? hit.getBlockPos() : null;
      if (!blockPos) return this.fail("面前没有 ME 终端方块");
      const side = facingSide(hit.getSide()?.getName());
      Player.getInteractionManager()?.interactBlock(
        blockPos.getX(),
        blockPos.getY(),
        blockPos.getZ(),
        side,
        false,
      );
      Player.getInteractionManager()?.holdInteract(true);
      this.useHeld = true;
      this.nextStepAt = Date.now() + TERMINAL_HOLD_MS;
      log(
        `按住右键方块 ${blockPos.getX()} ${blockPos.getY()} ${blockPos.getZ()} ${TERMINAL_HOLD_MS} 毫秒`,
      );
      return TaskResult.RUNNING;
    }
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    releaseUse();
    this.phase = "wait-terminal";
    this.nextStepAt = Date.now() + 6_000;
    return TaskResult.RUNNING;
  }

  private storeItems(): string {
    if (!this.swordSelected) {
      selectHotbar(SWORD_HOTBAR);
      this.swordSelected = true;
      this.storeAfter = Date.now() + TERMINAL_SYNC_MS;
      log("终端已打开，切回快捷栏 1");
      return TaskResult.RUNNING;
    }
    if (Date.now() < this.storeAfter) return TaskResult.RUNNING;
    if (!containerTitle().includes("ME综合终端")) return this.fail("终端界面关了，取消存储");
    if (this.sellIndex < this.storeSlots.length) {
      Player.openInventory()?.quick(this.storeSlots[this.sellIndex]);
      this.sellIndex += 1;
      return TaskResult.RUNNING;
    }
    this.phase = "finish";
    this.nextStepAt = Date.now() + 1_000;
    log(`已存入 ${this.storeSlots.length} 组`);
    return TaskResult.RUNNING;
  }

  private done(context: HunterContext): string {
    if (this.nextStepAt > Date.now()) return TaskResult.RUNNING;
    closeContainer();
    selectHotbar(SWORD_HOTBAR);
    if (isInventoryFull() || stillCarrying(context)) {
      log("背包还有东西，稍后重试");
      this.shopCommandSent = false;
      this.categoryClicked = false;
      this.phase = "retry";
      this.nextStepAt = Date.now() + 8_000;
      return TaskResult.RUNNING;
    }
    this.finishRequest(context);
    log("背包已腾出空位");
    return TaskResult.RUNNING;
  }

  private retry(context: HunterContext): string {
    if (Date.now() < this.nextStepAt) return TaskResult.RUNNING;
    if (!isInventoryFull() && !stillCarrying(context)) {
      this.finishRequest(context);
      return TaskResult.RUNNING;
    }
    this.restart();
    return this.goHome(context);
  }

  private finishRequest(context: HunterContext): void {
    this.active = false;
    if (context.clearForQuest) {
      context.clearForQuest = false;
      context.depositForUpgrade = false;
      context.upgradeReady = false;
      context.questTurnInReady = true;
      log("背包已腾出空位，去交任务");
      return;
    }
    if (!context.depositForUpgrade) return;
    context.depositForUpgrade = false;
    context.upgradeReady = true;
    log("出售和存储完成，准备升级");
  }

  private collectSlots(): void {
    const inv = Player.openInventory();
    if (!inv) return;
    const hotbar = toArray(inv.getSlots("hotbar"));
    const main = toArray(inv.getSlots("main"));
    const ordered = [...hotbar, ...main];
    this.sellSlots = [];
    this.storeSlots = [];
    ordered.forEach((slot, index) => {
      if (index === 0) return;
      const item = inv.getSlot(slot);
      if (item.isEmpty()) return;
      const name = plainText(item.getName()?.getString() ?? "");
      if (keepItemNames.some((keep) => name.includes(keep))) return;
      if (sellPrice(itemText(item)) === null) this.storeSlots.push(slot);
      else this.sellSlots.push(slot);
    });
  }
}

function facingSide(name: string | null | undefined): "up" | "down" | "north" | "south" | "east" | "west" {
  if (
    name === "up" ||
    name === "down" ||
    name === "north" ||
    name === "south" ||
    name === "east" ||
    name === "west"
  ) {
    return name;
  }
  return "up";
}

function slotName(inv: NonNullable<ReturnType<typeof Player.openInventory>>, slot: number): string {
  return plainText(inv.getSlot(slot).getName()?.getString() ?? "") || "物品";
}

function hotbarSlot(index: number): number | null {
  const slots = toArray(Player.openInventory()?.getSlots("hotbar"));
  return slots[index] ?? null;
}

function releaseUse(): void {
  Player.getInteractionManager()?.holdInteract(false);
}

function itemText(item: ItemStackHelper): string {
  const name = item.getName()?.getString() ?? "";
  const lore = toArray(item.getLore())
    .map((line) => line.getString())
    .join("\n");
  const nbt = item.getNBT();
  const nbtText = nbt ? nbt.asString() : "";
  return `${name}\n${lore}\n${nbtText}`;
}

export function hasGoodsToClear(): boolean {
  const inv = Player.openInventory();
  if (!inv || inv.isContainer()) return true;
  const hotbar = toArray(inv.getSlots("hotbar"));
  const main = toArray(inv.getSlots("main"));
  return [...hotbar, ...main].some((slot, index) => {
    if (index === 0) return false;
    const item = inv.getSlot(slot);
    if (item.isEmpty()) return false;
    const name = plainText(item.getName()?.getString() ?? "");
    return !keepItemNames.some((keep) => name.includes(keep));
  });
}

function stillCarrying(context: HunterContext): boolean {
  if (!context.clearForQuest) return false;
  const inv = Player.openInventory();
  if (!inv || inv.isContainer()) return false;
  return hasGoodsToClear();
}

function depositReason(context: HunterContext): string {
  if (context.clearForQuest) return "任务完成，回家清包再领奖励";
  if (context.depositForUpgrade) return "精英币够升级了，先出售并存储";
  return "背包已满，回家出售并存储";
}

function sellPrice(text: string): number | null {
  const match = text.match(/出售价格\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  return Number(match[1]);
}
