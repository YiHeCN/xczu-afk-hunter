import { Task, TaskResult } from "../../util/scheduler.ts";
import {
  canDoFieldWork,
  distance,
  log,
  hasLevitation,
  pathTo,
  playerPosition,
  steerToward,
  stopPathing,
  teleportProgress,
  toArray,
  tryUseHome,
  type HunterContext,
  type Vec3,
} from "../actions.ts";
import {
  ENGAGE_DISTANCE,
  MAX_MOB_Y_GAP,
  STUCK_DISTANCE,
  STUCK_MS,
  SURVEY_FIRST_MS,
  SWORD_HOTBAR,
  TaskPriority,
  homeList,
  type FarmSpot,
} from "../config.ts";

type HuntPhase = "home" | "arrive" | "hunt";

export class HuntTask extends Task {
  private phase: HuntPhase = "home";
  private spotIndex = 0;
  private depart: Vec3 | null = null;
  private departAt = 0;
  private anchor: Vec3 | null = null;
  private following = false;
  private followedId = "";
  private searchAfter = 0;
  private giveUpAt = 0;
  private loggedWait = false;
  private missingSince = 0;
  private triedLoot = new Set<string>();
  private lootId = "";
  private lootUntil = 0;
  private lootLogged = false;
  private nextLootLogAt = 0;
  private nextYLogAt = 0;
  private stillAt: Vec3 | null = null;
  private stillSince = 0;

  constructor() {
    super("hunt", TaskPriority.hunt);
  }

  shouldRun(context: HunterContext): boolean {
    return canDoFieldWork(context) && homeList.length > 0;
  }

  start(): void {
    this.restart();
  }

  resume(): void {
    this.restart();
  }

  suspend(): void {
    stopPathing();
  }

  abort(): void {
    this.suspend();
  }

  tick(context: HunterContext): string {
    const spot = homeList[this.spotIndex % homeList.length];
    if (!spot) return TaskResult.RUNNING;
    if (this.phase === "home") return this.goHome(context, spot);
    if (this.phase === "arrive") return this.waitArrival();
    return this.hunt(spot);
  }

  private restart(): void {
    stopPathing();
    this.phase = "home";
    this.depart = null;
    this.anchor = null;
    this.following = false;
    this.followedId = "";
    this.searchAfter = 0;
    this.giveUpAt = 0;
    this.loggedWait = false;
    this.missingSince = 0;
    this.triedLoot = new Set();
    this.lootId = "";
    this.lootUntil = 0;
    this.lootLogged = false;
    this.nextLootLogAt = 0;
    this.nextYLogAt = 0;
    this.stillAt = null;
    this.stillSince = 0;
  }

  private goHome(context: HunterContext, spot: FarmSpot): string {
    if (!tryUseHome(context, spot.home)) return TaskResult.RUNNING;
    this.depart = playerPosition();
    this.departAt = Date.now();
    this.phase = "arrive";
    return TaskResult.RUNNING;
  }

  private waitArrival(): string {
    const progress = teleportProgress(this.depart, this.departAt);
    if (progress === "moving") return TaskResult.RUNNING;
    if (progress === "missed") {
      this.phase = "home";
      log("传送没有生效，重新传送");
      return TaskResult.RUNNING;
    }
    this.anchor = playerPosition();
    this.phase = "hunt";
    this.following = false;
    this.followedId = "";
    this.searchAfter = Date.now() + SURVEY_FIRST_MS;
    this.giveUpAt = Date.now() + SURVEY_FIRST_MS + 6_000;
    this.loggedWait = false;
    this.missingSince = 0;
    this.triedLoot = new Set();
    this.lootId = "";
    this.lootUntil = 0;
    this.lootLogged = false;
    this.nextLootLogAt = 0;
    this.nextYLogAt = 0;
    this.stillAt = playerPosition();
    this.stillSince = Date.now();
    const here = this.anchor;
    log(
      here
        ? `到达刷怪点 ${here.x.toFixed(0)} ${here.y.toFixed(0)} ${here.z.toFixed(0)}`
        : "到达刷怪点",
    );
    return TaskResult.RUNNING;
  }

  private hunt(spot: FarmSpot): string {
    beginScan();
    const player = Player.getPlayer();
    const pos = playerPosition();
    if (!player || !pos || !this.anchor) {
      this.phase = "home";
      return TaskResult.RUNNING;
    }

    if (Date.now() < this.searchAfter) {
      if (!this.loggedWait) {
        this.loggedWait = true;
        log(`${spot.home} 等待怪物刷新`);
      }
      return TaskResult.RUNNING;
    }

    if (this.stuckTooLong(pos, spot)) return TaskResult.RUNNING;
    if (this.chaseLoot(player, pos, spot.searchRadius)) return TaskResult.RUNNING;
    this.logHighMobs(pos, spot.searchRadius, namedTargets(spot));

    const names = namedTargets(spot);
    let locked = this.followedId ? entityById(this.followedId, spot.searchRadius) : null;
    if (locked && isHuntMob(locked, names) && verticalGap(locked, pos) > MAX_MOB_Y_GAP) {
      const info = entityLabel(locked);
      const title = info.name || info.type || "怪物";
      log(`不打 ${title}，Y 轴差 ${verticalGap(locked, pos).toFixed(0)} 超过 ${MAX_MOB_Y_GAP}`);
      if (this.following) stopPathing();
      this.following = false;
      this.followedId = "";
      this.missingSince = 0;
      locked = null;
    }
    let target: EntityHelper | null = null;
    if (locked && isHuntMob(locked, names)) {
      this.missingSince = 0;
      target = locked;
    } else if (this.followedId) {
      if (this.missingSince === 0) this.missingSince = Date.now();
      if (Date.now() - this.missingSince < MOB_MISSING_MS) return TaskResult.RUNNING;
      this.missingSince = 0;
      this.followedId = "";
      target = nearestMob(pos, spot.searchRadius, names);
    } else {
      target = nearestMob(pos, spot.searchRadius, names);
    }
    if (!target) {
      if (this.following) stopPathing();
      this.following = false;
      this.followedId = "";
      if (Date.now() < this.giveUpAt) return TaskResult.RUNNING;
      this.nextSpot();
      log(`${spot.home} 没有可打的怪，去 ${homeList[this.spotIndex]?.home ?? ""}`);
      return TaskResult.RUNNING;
    }

    this.giveUpAt = Date.now() + 8_000;
    const info = entityLabel(target);
    const title = info.name || info.type || "怪物";
    if (target.getUUID() !== this.followedId) {
      Player.openInventory()?.setSelectedHotbarSlotIndex(SWORD_HOTBAR);
    }
    if (target.getUUID() !== this.followedId) {
      this.followedId = target.getUUID();
      log(`走向 ${title} [${info.type}]，距离 ${player.distanceTo(target).toFixed(1)}`);
    }
    moveToward(target);
    this.following = true;
    return TaskResult.RUNNING;
  }

  private stuckTooLong(pos: Vec3, spot: FarmSpot): boolean {
    if (!this.following || !this.stillAt || distance(this.stillAt, pos) >= STUCK_DISTANCE) {
      this.stillAt = pos;
      this.stillSince = Date.now();
      return false;
    }
    if (Date.now() - this.stillSince < STUCK_MS) return false;
    const next = homeList.length > 1 ? homeList[(this.spotIndex + 1) % homeList.length]?.home : spot.home;
    log(`${spot.home} 原地超过 ${STUCK_MS / 1000} 秒，寻路卡住，去 ${next ?? ""}`);
    this.nextSpot();
    return true;
  }

  private chaseLoot(
    player: NonNullable<ReturnType<typeof Player.getPlayer>>,
    pos: Vec3,
    radius: number,
  ): boolean {
    this.logLoot(pos, radius);
    const loot = this.lootId ? entityById(this.lootId, radius) : nearestLoot(pos, radius, this.triedLoot);
    if (loot && verticalGap(loot, pos) > MAX_MOB_Y_GAP) {
      if (this.lootId) this.finishLoot("掉落物不在这一层");
      return false;
    }
    if (!loot) {
      if (!this.lootId) return false;
      this.finishLoot("掉落物不在了，继续打怪");
      return true;
    }
    if (this.lootId !== loot.getUUID()) {
      this.lootId = loot.getUUID();
      this.lootUntil = Date.now() + LOOT_CHASE_MS;
      const info = entityLabel(loot);
      log(
        `去捡 ${info.name || "掉落物"} [${info.type}] 存活 ${info.alive ? "是" : "否"}，距离 ${player.distanceTo(loot).toFixed(1)}，Y 轴差 ${verticalGap(loot, pos).toFixed(1)}`,
      );
    }
    if (player.distanceTo(loot) <= 1.8 || Date.now() >= this.lootUntil) {
      stopPathing();
      this.finishLoot(player.distanceTo(loot) <= 1.8 ? "走到掉落物旁边" : "捡不起来，继续打怪");
      return true;
    }
    moveToward(loot);
    this.following = true;
    return true;
  }

  private logHighMobs(origin: Vec3, radius: number, extraNames: string[]): void {
    if (Date.now() < this.nextYLogAt) return;
    let noted = 0;
    const lines: string[] = [];
    for (const entity of loadedEntities(radius)) {
      if (!isHuntMob(entity, extraNames)) continue;
      const gap = verticalGap(entity, origin);
      if (gap <= MAX_MOB_Y_GAP) continue;
      const pos = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
      if (distance(pos, origin) > radius) continue;
      const info = entityLabel(entity);
      lines.push(`${info.name || info.type || "怪物"} Y差${gap.toFixed(0)}`);
      noted += 1;
      if (noted >= 4) break;
    }
    if (lines.length === 0) return;
    this.nextYLogAt = Date.now() + 8_000;
    log(`Y 轴差超过 ${MAX_MOB_Y_GAP}，不打：${lines.join("；")}`);
  }

  private logLoot(origin: Vec3, radius: number): void {
    const now = Date.now();
    const rows = lootCandidates(origin, radius);
    if (rows.length === 0) {
      if (this.lootLogged) return;
      this.lootLogged = true;
      log(`拾取检查：半径 ${radius} 内没有掉落物或精英币`);
      return;
    }
    if (now < this.nextLootLogAt) return;
    this.lootLogged = true;
    this.nextLootLogAt = now + 8_000;
    const pending = rows.filter((row) => row.reason === null && !this.triedLoot.has(row.id)).length;
    const state = pending > 0 ? `还有 ${pending} 个会去捡` : "这些已经试过";
    log(`拾取检查（${state}）：${rows.slice(0, 8).map((row) => formatLoot(row, this.triedLoot.has(row.id))).join("；")}`);
  }

  private finishLoot(message: string): void {
    if (this.lootId) this.triedLoot.add(this.lootId);
    this.lootId = "";
    this.following = false;
    this.followedId = "";
    log(message);
  }

  private nextSpot(): void {
    stopPathing();
    if (homeList.length > 1) this.spotIndex = (this.spotIndex + 1) % homeList.length;
    this.phase = "home";
    this.following = false;
    this.followedId = "";
    this.stillAt = null;
    this.stillSince = 0;
  }
}

const MOB_MISSING_MS = 2_000;
const LOOT_CHASE_MS = 4_000;

let scanned: EntityHelper[] | null = null;
let scannedRadius = -1;

function beginScan(): void {
  scanned = null;
}

function moveToward(entity: EntityHelper): void {
  const player = Player.getPlayer();
  const close = hasLevitation() || (player != null && player.distanceTo(entity) <= ENGAGE_DISTANCE);
  if (close) {
    const eye = entity.getEyeHeight() || 1.6;
    steerToward(entity.getX(), entity.getY() + eye * 0.85, entity.getZ());
    return;
  }
  const block = entity.getBlockPos();
  pathTo(block.getX(), block.getY(), block.getZ());
}

function namedTargets(spot: FarmSpot): string[] {
  return spot.targets.map((target) => target.trim()).filter((target) => target.length > 0);
}

function entityById(id: string, radius: number): EntityHelper | null {
  for (const entity of loadedEntities(radius)) {
    if (entity.getUUID() === id) return entity;
  }
  return null;
}

function lootReject(entity: EntityHelper): string | null {
  const { type, name, alive } = entityLabel(entity);
  if (type === "minecraft:player" || type === "minecraft:armor_stand") return "玩家或盔甲架";
  if (!alive) return "未存活";
  if (type === "minecraft:item" || name.includes("精英币")) return null;
  return "类型不符";
}

function isLoot(entity: EntityHelper): boolean {
  return lootReject(entity) === null;
}

function looksLikeLoot(entity: EntityHelper): boolean {
  const { type, name } = entityLabel(entity);
  if (lootReject(entity) === null || lootReject(entity) === "未存活") return true;
  return type.includes("item") || type.includes("experience") || type.includes("orb") || name.includes("币");
}

function lootCandidates(origin: Vec3, radius: number): LootCandidate[] {
  const player = Player.getPlayer();
  const rows: LootCandidate[] = [];
  for (const entity of loadedEntities(radius)) {
    if (player && entity.getUUID() === player.getUUID()) continue;
    if (!looksLikeLoot(entity)) continue;
    const pos = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
    const away = distance(pos, origin);
    if (away > radius) continue;
    const info = entityLabel(entity);
    rows.push({
      id: entity.getUUID(),
      type: info.type || "无类型",
      name: info.name || "无名字",
      alive: info.alive,
      away,
      gap: verticalGap(entity, origin),
      reason: lootReject(entity),
    });
  }
  rows.sort((a, b) => a.away - b.away);
  return rows;
}

type LootCandidate = {
  id: string;
  type: string;
  name: string;
  alive: boolean;
  away: number;
  gap: number;
  reason: string | null;
};

function formatLoot(row: LootCandidate, tried: boolean): string {
  const verdict = row.reason ? `不捡(${row.reason})` : tried ? "已试过" : "会捡";
  return `${row.name} [${row.type}] ${row.alive ? "存活" : "未存活"} 距${row.away.toFixed(1)} Y差${row.gap.toFixed(1)} ${verdict}`;
}

function verticalGap(entity: EntityHelper, origin: Vec3): number {
  return Math.abs(entity.getY() - origin.y);
}

function nearestLoot(origin: Vec3, radius: number, skip: ReadonlySet<string>): EntityHelper | null {
  const player = Player.getPlayer();
  let best: EntityHelper | null = null;
  let bestDistance = Infinity;
  for (const entity of loadedEntities(radius)) {
    if (player && entity.getUUID() === player.getUUID()) continue;
    if (skip.has(entity.getUUID())) continue;
    if (!isLoot(entity)) continue;
    if (verticalGap(entity, origin) > MAX_MOB_Y_GAP) continue;
    const pos = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
    const away = distance(pos, origin);
    if (away > radius || away >= bestDistance) continue;
    best = entity;
    bestDistance = away;
  }
  return best;
}

const MOB_TYPES = new Set([
  "minecraft:vindicator",
  "minecraft:ravager",
  "minecraft:skeleton",
  "minecraft:wither_skeleton",
  "minecraft:stray",
  "minecraft:bogged",
  "minecraft:zombie",
  "minecraft:husk",
  "minecraft:drowned",
  "minecraft:pillager",
  "minecraft:evoker",
  "minecraft:vex",
  "minecraft:witch",
  "minecraft:zoglin",
]);

const NAME_MARKS = ["凯伦", "蛇人", "坎卜斯", "亡灵骷髅"];

function isHuntMob(entity: EntityHelper, extraNames: string[]): boolean {
  const { type, name, alive } = entityLabel(entity);
  if (!alive) return false;
  if (type === "minecraft:armor_stand" || type === "minecraft:snow_golem" || type === "minecraft:item") {
    return false;
  }
  if (type === "minecraft:player") return name.includes("§L§D");
  if (MOB_TYPES.has(type)) return true;
  if (NAME_MARKS.some((mark) => name.includes(mark))) return true;
  return extraNames.some((mark) => name.includes(mark));
}

function nearestMob(origin: Vec3, radius: number, extraNames: string[]): EntityHelper | null {
  const player = Player.getPlayer();
  let best: EntityHelper | null = null;
  let bestDistance = Infinity;

  for (const entity of loadedEntities(radius)) {
    if (player && entity.getUUID() === player.getUUID()) continue;
    if (!isHuntMob(entity, extraNames)) continue;
    if (verticalGap(entity, origin) > MAX_MOB_Y_GAP) continue;
    const pos = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
    const away = distance(pos, origin);
    if (away > radius || away >= bestDistance) continue;
    best = entity;
    bestDistance = away;
  }
  return best;
}

function entityLabel(entity: EntityHelper): { type: string; name: string; alive: boolean } {
  let type = "";
  let name = "";
  let alive = false;
  try {
    type = entity.getType() ?? "";
  } catch {
    type = "";
  }
  try {
    name = (entity.getName()?.getString() ?? "").trim();
  } catch {
    name = "";
  }
  try {
    alive = entity.isAlive();
  } catch {
    alive = false;
  }
  return { type, name, alive };
}

function loadedEntities(radius: number): EntityHelper[] {
  if (scanned && scannedRadius === radius) return scanned;
  const seen = new Set<string>();
  const out: EntityHelper[] = [];
  for (const source of [World.getEntities(), World.getEntities(radius)]) {
    for (const entity of toArray(source)) {
      const id = entity.getUUID();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entity);
    }
  }
  scanned = out;
  scannedRadius = radius;
  return out;
}
