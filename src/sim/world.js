/**
 * 玩法世界的最小骨架 —— M0-b 只验证工具链，不是 M1 的内核。
 *
 * 唯一在这里就定死的东西是 **tick 顺序**，因为它是 ADR-002 r2 的冻结语义
 * （见 docs/design/adr-002-eventsheet-eval.md §3），而不是实现细节：
 * 顺序定错，作品行为会漂移，且迁移链救不回来。
 *
 * 这个文件零 three.js 依赖 —— 不变量 I7「任何时候都能不开界面跑完整场景并断言结果」。
 */
import RAPIER from '@dimforge/rapier3d-compat';
export { PHYSICS_RUNTIME_REQUIREMENT } from '../core/runtime-versions.js';

export const TICK_DT = 1 / 60;

/** 事件入队前的稳定排序键（ADR-002 r2 的 D4）。 */
function eventSortKey(e) {
  // 物理引擎交回的原始顺序不保证跨平台一致，顺序不同就足以让世界状态分叉。
  return [e.kind, Math.min(e.a, e.b), Math.max(e.a, e.b)];
}

function compareEvents(x, y) {
  const kx = eventSortKey(x), ky = eventSortKey(y);
  for (let i = 0; i < kx.length; i++) {
    if (kx[i] !== ky[i]) return kx[i] < ky[i] ? -1 : 1;
  }
  return 0;
}

export async function initPhysics() {
  await RAPIER.init();
  return RAPIER;
}

export class World {
  constructor(rapier) {
    this.rapier = rapier;
    this.physics = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = TICK_DT;
    this.events = new rapier.EventQueue(true);
    this.bodies = [];
    this.tick = 0;
  }

  addGround(halfExtent = 20) {
    const body = this.physics.createRigidBody(this.rapier.RigidBodyDesc.fixed());
    this.physics.createCollider(
      this.rapier.ColliderDesc.cuboid(halfExtent, 0.5, halfExtent).setActiveEvents(
        this.rapier.ActiveEvents.COLLISION_EVENTS
      ),
      body
    );
    return body;
  }

  addBox(x, y, z) {
    const body = this.physics.createRigidBody(
      this.rapier.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    );
    this.physics.createCollider(
      this.rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setActiveEvents(this.rapier.ActiveEvents.COLLISION_EVENTS)
        .setRestitution(0.35),
      body
    );
    this.bodies.push(body);
    return body;
  }

  /**
   * 一个 tick。步骤编号对应 ADR-002 §3 的 tick 流程。
   * 步骤 1（输入意图）、3（排空触发）、4（全表求值）、5（等待队列与计时器）
   * 要等 M1 / M2 才有内容，这里先把 2 与 2.5 落实，并保留编号位置。
   */
  step() {
    // 1. 采样输入意图 —— M1 补
    this.physics.step(this.events);                    // 2. 物理步进

    const collected = [];                              // 2.5 收集 + 稳定排序
    this.events.drainCollisionEvents((a, b, started) => {
      collected.push({ kind: started ? 1 : 0, a, b });
    });
    collected.sort(compareEvents);

    // 3. 排空触发队列 —— M2 补（载荷已销毁则跳过，E4）
    // 4. 全表自上而下求值常规规则 —— M2 补
    // 5. 结算等待队列与计时器 —— M2 补

    this.tick++;
    return collected;
  }

  /** 玩法状态的指纹。断言范围限定在玩法状态，不含渲染（goals.md §4.5）。 */
  stateFingerprint() {
    const parts = [];
    for (const b of this.bodies) {
      const t = b.translation(), r = b.rotation();
      parts.push([t.x, t.y, t.z, r.x, r.y, r.z, r.w].map((v) => v.toFixed(9)).join(','));
    }
    return parts.join('|');
  }

  free() {
    this.events.free();
    this.physics.free();
  }
}
