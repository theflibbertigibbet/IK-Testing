export interface Bone {
  name: string;
  length: number;
  angle: number;
  targetAngle?: number;
  mass: number;
  children: Bone[];
  zIndex?: number;
  visible?: boolean;
  globalPos?: { start: { x: number; y: number }; end: { x: number; y: number } };
  globalAngle?: number;
}

// The core proportional unit. All bone lengths are a factor of this value.
export const ANATOMICAL_SCALE = 50; 

// --- Limb Definitions ---
// These component parts define the major limbs of the skeleton.

// --- ARMS --- (No change needed, base angles were already 0)
const L_ARM: Bone = {
  name: "L_Clavicle", length: ANATOMICAL_SCALE * 0.75, angle: -Math.PI / 2, mass: 0, zIndex: 3,
  children: [{
    name: "L_Shoulder", length: ANATOMICAL_SCALE * 1.5, angle: 0, mass: 6, zIndex: 3,
    children: [
      { name: "L_Forearm", length: ANATOMICAL_SCALE * 1.25, angle: 0, mass: 5, zIndex: 3, children: [
        { name: "L_Hand", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 2, zIndex: 3, children: [] }
      ]}
    ]
  }]
};
const R_ARM: Bone = {
  name: "R_Clavicle", length: ANATOMICAL_SCALE * 0.75, angle: Math.PI / 2, mass: 0, zIndex: 3,
  children: [{
    name: "R_Shoulder", length: ANATOMICAL_SCALE * 1.5, angle: 0, mass: 6, zIndex: 3,
    children: [
      { name: "R_Forearm", length: ANATOMICAL_SCALE * 1.25, angle: 0, mass: 5, zIndex: 3, children: [
        { name: "R_Hand", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 2, zIndex: 3, children: [] }
      ]}
    ]
  }]
};

// --- LEGS --- (Restructured for Zero-State T-Pose with vertical legs)

// --- LEFT LEG ---
const L_FOOT_ASSEMBLY: Bone = { name: "L_Foot", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 3, zIndex: 3, children: [] };
const L_ANKLE_JOINT: Bone = { name: "L_Ankle_Joint", length: 0, angle: Math.PI / 2, mass: 0, children: [L_FOOT_ASSEMBLY] };
const L_CALF_ASSEMBLY: Bone = { name: "L_Calf", length: ANATOMICAL_SCALE * 1.75, angle: 0, mass: 8, zIndex: 3, children: [L_ANKLE_JOINT] };
const L_HIP_ASSEMBLY: Bone = { name: "L_Hip", length: ANATOMICAL_SCALE * 1.75, angle: 0, mass: 10, zIndex: 3, children: [L_CALF_ASSEMBLY] };
const L_HIP_BASE_JOINT: Bone = { name: "L_Hip_Base_Joint", length: 0, angle: -Math.PI / 2, mass: 0, children: [L_HIP_ASSEMBLY] };
const L_LEG: Bone = {
  name: "L_Hip_Joint", length: ANATOMICAL_SCALE * 0.5, angle: Math.PI / 2, mass: 0, zIndex: 3,
  children: [L_HIP_BASE_JOINT]
};

// --- RIGHT LEG ---
const R_FOOT_ASSEMBLY: Bone = { name: "R_Foot", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 3, zIndex: 3, children: [] };
const R_ANKLE_JOINT: Bone = { name: "R_Ankle_Joint", length: 0, angle: -Math.PI / 2, mass: 0, children: [R_FOOT_ASSEMBLY] };
const R_CALF_ASSEMBLY: Bone = { name: "R_Calf", length: ANATOMICAL_SCALE * 1.75, angle: 0, mass: 8, zIndex: 3, children: [R_ANKLE_JOINT] };
const R_HIP_ASSEMBLY: Bone = { name: "R_Hip", length: ANATOMICAL_SCALE * 1.75, angle: 0, mass: 10, zIndex: 3, children: [R_CALF_ASSEMBLY] };
const R_HIP_BASE_JOINT: Bone = { name: "R_Hip_Base_Joint", length: 0, angle: Math.PI / 2, mass: 0, children: [R_HIP_ASSEMBLY] };
const R_LEG: Bone = {
  name: "R_Hip_Joint", length: ANATOMICAL_SCALE * 0.5, angle: -Math.PI / 2, mass: 0, zIndex: 3,
  children: [R_HIP_BASE_JOINT]
};


// --- Torso and Pelvis Assembly ---
const HEAD_ASSEMBLY: Bone = { name: "Head", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 5, zIndex: 4, children: [] };
const NECK_ASSEMBLY: Bone = { name: "Neck", length: ANATOMICAL_SCALE * 0.5, angle: 0, mass: 2, zIndex: 2, children: [HEAD_ASSEMBLY] };

const TORSO_ASSEMBLY: Bone = {
    name: "Torso", length: ANATOMICAL_SCALE * 1.5, angle: 0, mass: 20, zIndex: 1,
    children: [ NECK_ASSEMBLY, L_ARM, R_ARM ]
};
const TORSO_BASE_JOINT: Bone = { name: "Torso_Base_Joint", length: 0, angle: -Math.PI / 2, mass: 0, children: [TORSO_ASSEMBLY] };

const PELVIS_ASSEMBLY: Bone = {
    name: "Pelvis", length: ANATOMICAL_SCALE * 1.0, angle: 0, mass: 15, zIndex: 2,
    children: [ L_LEG, R_LEG ]
};
const PELVIS_BASE_JOINT: Bone = { name: "Pelvis_Base_Joint", length: 0, angle: Math.PI / 2, mass: 0, children: [PELVIS_ASSEMBLY] };

const SPINE_AND_HEAD: Bone[] = [ TORSO_BASE_JOINT, PELVIS_BASE_JOINT ];

// A robust, perfectly proportioned 8-head skeletal structure.
// The default pose is standing, with arms in a T-pose.
// - Navel to top of head = 3 head units
// - Navel to bottom of feet = 4 head units
export const SKELETON_TREE: Bone = {
  name: "Navel", length: 0, angle: 0, mass: 10, zIndex: 0,
  children: SPINE_AND_HEAD
};

export const computeGlobalPositions = (bone: Bone, parentX: number, parentY: number, parentAngle: number): void => {
  const globalAngle = parentAngle + bone.angle;
  bone.globalAngle = globalAngle;
  const endX = parentX + Math.cos(globalAngle) * bone.length;
  const endY = parentY + Math.sin(globalAngle) * bone.length;

  bone.globalPos = { start: { x: parentX, y: parentY }, end: { x: endX, y: endY } };

  bone.children.forEach(child =>
    computeGlobalPositions(child, endX, endY, globalAngle)
  );
};