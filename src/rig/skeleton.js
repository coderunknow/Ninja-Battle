// Procedural bipedal skeleton for the two fighters.
//
// Design notes
// ------------
// Each character is a 2D articulated skeleton with 20+ degrees of freedom driven by
// a *pose object* (plain numbers, in radians / local units). Poses are produced by:
//   1. a library of key poses (guard, hook windup, hook impact, run cycle keys, ...)
//   2. blending / additive layering (breath, bounce, hair flutter, cloth drag)
//   3. procedural two-bone IK for planted feet and for locked-on strikes
//
// The skeleton is evaluated to world-space joints, which are then used by the
// renderer (limbs, cloth, hair, effects anchors). No canvas knowledge lives here,
// which is what lets the identical code run in the headless QA renderer.

import { clamp, clamp01, lerp, ease, TAU } from '../core/math.js';

// --- Pose schema ---------------------------------------------------------------
// Angles are in radians. For limbs: 0 = pointing straight down, positive = swing
// toward the facing direction (+x in local space, i.e. "forward").
export function makePose(over = {}) {
  return Object.assign(
    {
      // root
      hipY: 0,          // vertical offset of the hips (negative = crouch) in px
      hipX: 0,          // horizontal weight shift
      torso: 0,         // torso lean (rotation about hips), + = lean forward
      torsoTwist: 0,    // mild fake-3D twist, scales shoulder width
      head: 0,          // head tilt relative to torso
      headX: 0, headY: 0,
      // arms: shoulder -> elbow -> wrist. aX = arm swing, eX = elbow bend
      armFront: 0.0, armFrontElbow: 0.35,
      armBack: 0.0, armBackElbow: 0.35,
      // hands: rotation of palm/grip, and open/closed state 0..1
      handFront: 0, handBack: 0, gripFront: 1, gripBack: 1,
      // legs: hip -> knee -> ankle. lX = thigh swing, kX = knee bend (always >=0)
      legFront: 0.0, legFrontKnee: 0.12,
      legBack: 0.0, legBackKnee: 0.12,
      footFront: 0, footBack: 0,
      // weapon / prop anchor: how far the "active hand" is extended
      propT: 0,         // 0 = held at hip, 1 = full extension
      // misc additive channels used by renderer + fx
      glow: 0, scream: 0, lean: 0,
    },
    over
  );
}

// Named channel list so blending can be data-driven and typo-proof.
const CHANNELS = Object.keys(makePose());

export function blendPose(a, b, t) {
  const out = {};
  for (const k of CHANNELS) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
  return out;
}

// Additive layering: `b` values are added scaled by w.
export function addPose(a, b, w = 1) {
  const out = { ...a };
  for (const k of CHANNELS) out[k] = (a[k] ?? 0) + (b[k] ?? 0) * w;
  return out;
}

// --- Skeleton proportions ------------------------------------------------------
// Units are "world pixels at scale 1". A standing fighter is ~ 196 px tall which
// reads well for a 16:9 frame at 1.0 zoom on a 1080p view.
export function makeRig(opts = {}) {
  const o = Object.assign(
    {
      scale: 1,
      hipWidth: 14,
      shoulderWidth: 29,
      torsoLen: 58,     // hip -> neck
      neckLen: 5,
      headR: 14.2,
      upperArm: 30,
      foreArm: 28,
      handLen: 7,
      thigh: 34,
      shin: 33,
      footLen: 22,
      hair: 'spiky',
      colors: {},
    },
    opts
  );
  o.height = o.thigh + o.shin + o.torsoLen + o.neckLen + o.headR * 2;
  return o;
}

// --- Forward kinematics -------------------------------------------------------
// Local space: +x is the character's facing direction, -y is up.
// Returns a joint dictionary in local coordinates relative to the ground point
// under the hips (the character's "anchor").
export function solveSkeleton(rig, pose, extra = {}) {
  const p = pose;
  
  const hip = { x: p.hipX, y: p.hipY };
  const torsoAngle = p.torso - Math.PI / 2; // torso points "up" at rest
  const twist = clamp(p.torsoTwist, -0.6, 0.6);

  // spine is a 3-segment chain so the silhouette curves instead of being a stick.
  const seg = rig.torsoLen / 3;
  const chain = [];
  let ang = torsoAngle;
  let cx = hip.x, cy = hip.y;
  chain.push({ x: cx, y: cy });
  // Slight S-curve: hips lean, chest leads.
  const curve = [1.0, 0.92, 0.75];
  for (let i = 0; i < 3; i++) {
    ang += (p.torso - 0) * 0.08 * curve[i];
    cx += Math.cos(ang) * seg;
    cy += Math.sin(ang) * seg;
    chain.push({ x: cx, y: cy });
  }
  const chest = chain[2];
  const neck = chain[3];

  // The head is drawn in an upright local frame, so it only inherits a fraction
  // of the torso lean (plus its own nod) — never the +/-90deg spine basis.
  const headAng = p.torso * 0.55 + p.head;
  const headC = {
    x: neck.x + Math.cos(headAng) * (rig.neckLen + rig.headR * 0.55) + p.headX,
    y: neck.y + Math.sin(headAng) * (rig.neckLen + rig.headR * 0.55) + p.headY,
  };

  // Shoulders: offset perpendicular to torso, scaled by twist to fake rotation.
  const perp = { x: Math.cos(torsoAngle + Math.PI / 2), y: Math.sin(torsoAngle + Math.PI / 2) };
  const sw = rig.shoulderWidth * 0.5 * (1 - Math.abs(twist) * 0.55);
  const shoulderC = { x: chest.x, y: chest.y + 2 };
  const shoulderFront = { x: shoulderC.x + perp.x * sw, y: shoulderC.y + perp.y * sw };
  const shoulderBack = { x: shoulderC.x - perp.x * sw, y: shoulderC.y - perp.y * sw };

  // Arms. Local "down" is +y, so rest angle = PI/2; aX rotates forward (+x).
  const solveArm = (root, swing, elbow, handRot) => {
    const a1 = Math.PI / 2 - swing;
    const elbowJ = {
      x: root.x + Math.cos(a1) * rig.upperArm,
      y: root.y + Math.sin(a1) * rig.upperArm,
    };
    const a2 = a1 + elbow;
    const wrist = {
      x: elbowJ.x + Math.cos(a2) * rig.foreArm,
      y: elbowJ.y + Math.sin(a2) * rig.foreArm,
    };
    const a3 = a2 + handRot;
    const tip = {
      x: wrist.x + Math.cos(a3) * rig.handLen,
      y: wrist.y + Math.sin(a3) * rig.handLen,
    };
    return { root, elbow: elbowJ, wrist, tip, angle: a2 };
  };

  const armFront = solveArm(shoulderFront, p.armFront, p.armFrontElbow, p.handFront);
  const armBack = solveArm(shoulderBack, p.armBack, p.armBackElbow, p.handBack);

  // Legs
  const hipFront = { x: hip.x + rig.hipWidth * 0.4, y: hip.y };
  const hipBack = { x: hip.x - rig.hipWidth * 0.4, y: hip.y };

  const solveLeg = (root, swing, knee, footRot) => {
    const a1 = Math.PI / 2 - swing;
    const kneeJ = {
      x: root.x + Math.cos(a1) * rig.thigh,
      y: root.y + Math.sin(a1) * rig.thigh,
    };
    const a2 = a1 - knee;
    const ankle = {
      x: kneeJ.x + Math.cos(a2) * rig.shin,
      y: kneeJ.y + Math.sin(a2) * rig.shin,
    };
    const a3 = a2 + Math.PI / 2 + footRot; // foot forward
    const toe = {
      x: ankle.x + Math.cos(a3) * rig.footLen,
      y: ankle.y + Math.sin(a3) * rig.footLen,
    };
    const heel = {
      x: ankle.x - Math.cos(a3) * rig.footLen * 0.35 - Math.sin(a3) * 4,
      y: ankle.y - Math.sin(a3) * rig.footLen * 0.35 + Math.cos(a3) * 4,
    };
    return { root, knee: kneeJ, ankle, toe, heel, angle: a2 };
  };

  const legFront = solveLeg(hipFront, p.legFront, p.legFrontKnee, p.footFront);
  const legBack = solveLeg(hipBack, p.legBack, p.legBackKnee, p.footBack);

  const joints = {
    hip, chain, chest, neck, head: headC, shoulderFront, shoulderBack,
    armFront, armBack, legFront, legBack,
    torsoAngle, headAng,
  };

  // Limb lengths for IK and impact bookkeeping
  joints.armLen = (rig.upperArm + rig.foreArm + rig.handLen);
  joints.legLen = (rig.thigh + rig.shin);
  joints.reach = {
    front: armFront.wrist,
    back: armBack.wrist,
  };
  return joints;
}

// --- Two-bone IK -------------------------------------------------------------
// Returns [swing, elbowBend] that puts the wrist at `target` (local space),
// given a shoulder root. Used for grounded feet and for attacks aimed at a
// specific world point, which keeps hands/feet from ever missing their hitbox.
export function ikArm(rig, root, target, preferFront = true) {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const dist = Math.hypot(dx, dy);
  const l1 = rig.upperArm * rig.scale;
  const l2 = (rig.foreArm + rig.handLen * 0.5) * rig.scale;
  const d = clamp(dist, Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001);
  const base = Math.atan2(dy, dx);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);
  const elbowUp = preferFront ? base - a : base + a;
  const swing = Math.PI / 2 - elbowUp;
  // elbow interior angle -> our `elbowBend` channel (positive = more bent forward)
  const cosE = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const bend = Math.PI - Math.acos(cosE);
  return [swing, preferFront ? bend : -bend];
}

// Solve leg so the ankle lands on `target`; returns [swing, knee].
export function ikLeg(rig, root, target) {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const dist = Math.hypot(dx, dy);
  const l1 = rig.thigh * rig.scale;
  const l2 = rig.shin * rig.scale;
  const d = clamp(dist, Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001);
  const base = Math.atan2(dy, dx);
  const cosE = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const knee = Math.PI - Math.acos(cosE);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);
  // Knee bends backward (toward -x when facing +x): thigh angle should be base + a
  const thighWorld = base + a;
  const swing = Math.PI / 2 - thighWorld;
  return [swing, knee];
}

export { CHANNELS };
