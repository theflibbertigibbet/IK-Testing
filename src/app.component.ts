import { Component, ChangeDetectionStrategy, signal, effect, viewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Bone, SKELETON_TREE, computeGlobalPositions, ANATOMICAL_SCALE } from './app/kinematics';

type MotionMode = 'T-Pose' | 'Tension' | 'Collapse';
interface PhysicsPoint { x: number; y: number; oldX: number; oldY: number; isPinned: boolean; }
interface PhysicsStick { p0: PhysicsPoint; p1: PhysicsPoint; length: number; }
interface AnimationState {
  active: boolean;
  startSkeleton: Bone | null;
  targetSkeleton: Bone | null;
  startOffsets: { x: number, y: number };
  targetOffsets: { x: number, y: number };
  durationFrames: number;
  currentFrame: number;
  targetMode: MotionMode | null;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements AfterViewInit, OnDestroy {
  canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('skeletonCanvas');
  private ctx: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver;
  readonly initialSkeleton: Bone;
  readonly tensionPoseSkeleton: Bone;
  private pressTimer: any;

  skeleton = signal<Bone>(SKELETON_TREE);
  showCharacterSheet = signal(false);
  motionMode = signal<MotionMode>('Tension');
  
  lastAdjustedGroup = signal<string | null>(null);
  activeControl = signal<string | null>(null);
  navelOffsetX = signal<number>(0);
  navelOffsetY = signal<number>(0);
  
  lockedBones = signal(new Map<string, { position: { x: number; y: number } }>());
  private lockedChainCache = new Set<string>();

  private physicsPoints: PhysicsPoint[] = [];
  private physicsSticks: PhysicsStick[] = [];
  private navelVelocity = { x: 0, y: 0 };
  private animationFrameId: number | null = null;
  private lastTimestamp: number = 0;

  animationState = signal<AnimationState>({ active: false, startSkeleton: null, targetSkeleton: null, startOffsets: {x:0, y:0}, targetOffsets: {x:0, y:0}, durationFrames: 0, currentFrame: 0, targetMode: null });
  private boneToPointsMap = new Map<string, { p0: PhysicsPoint, p1: PhysicsPoint }>();

  private readonly anatomicalGroups: Record<string, string[]> = {
    'CORE': ['Navel', 'Torso', 'Pelvis', 'Neck', 'Head'],
    'L_ARM': ['L_Clavicle', 'L_Shoulder', 'L_Forearm', 'L_Hand'],
    'R_ARM': ['R_Clavicle', 'R_Shoulder', 'R_Forearm', 'R_Hand'],
    'L_LEG': ['L_Hip_Joint', 'L_Hip', 'L_Calf', 'L_Foot'],
    'R_LEG': ['R_Hip_Joint', 'R_Hip', 'L_Calf', 'R_Foot'],
  };

  private readonly boneToGroupMap: Record<string, string> = {
    'Torso': 'CORE', 'Neck': 'CORE', 'Head': 'CORE',
    'L_Shoulder': 'L_ARM', 'L_Forearm': 'L_ARM', 'L_Hand': 'L_ARM',
    'R_Shoulder': 'R_ARM', 'R_Forearm': 'R_ARM', 'R_Hand': 'R_ARM',
    'L_Hip': 'L_LEG', 'L_Calf': 'L_LEG', 'L_Foot': 'L_LEG',
    'R_Hip': 'R_LEG', 'R_Calf': 'R_LEG', 'R_Foot': 'R_LEG',
  };

  readonly controlGroups = [
    { name: 'Core', bones: ['Navel', 'Torso', 'Neck'] },
    { name: 'Left Arm', bones: ['L_Shoulder', 'L_Forearm', 'L_Hand'] },
    { name: 'Right Arm', bones: ['R_Shoulder', 'R_Forearm', 'R_Hand'] },
    { name: 'Left Leg', bones: ['L_Hip', 'L_Calf', 'L_Foot'] },
    { name: 'Right Leg', bones: ['R_Hip', 'R_Calf', 'R_Foot'] },
  ];
  
  readonly boneMetadata = new Map<string, { min: number; max: number; step: number; }>();
  readonly lockableBones = ['L_Foot', 'R_Foot', 'L_Hand', 'R_Hand'];

  constructor() {
    this.initialSkeleton = this.createVisibleSkeleton(SKELETON_TREE);
    this.tensionPoseSkeleton = this.createTensionPose();
    this.skeleton.set(this.deepClone(this.tensionPoseSkeleton));

    const controllableBones: { name: string; min: number; max: number; step: number; }[] = [
        { name: 'Navel', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'Torso', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'Neck', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Shoulder', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Shoulder', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Forearm', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Forearm', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Hand', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Hand', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Hip', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Hip', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Calf', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Calf', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'L_Foot', min: -Math.PI, max: Math.PI, step: 0.01 },
        { name: 'R_Foot', min: -Math.PI, max: Math.PI, step: 0.01 },
    ];
    controllableBones.forEach(bone => this.boneMetadata.set(bone.name, bone));
    this.boneMetadata.set('Ground X', { min: -200, max: 200, step: 1 });
    this.boneMetadata.set('Ground Y', { min: -200, max: 200, step: 1 });
    this.boneMetadata.set('Global Rotation', { min: -Math.PI, max: Math.PI, step: 0.01 });

    effect(() => {
      this.skeleton(); this.showCharacterSheet(); this.navelOffsetX(); this.navelOffsetY(); this.lockedBones();
      if (this.ctx && !this.animationState().active && this.motionMode() !== 'Collapse') { 
        this.draw(); 
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
        if (this.ctx) { this.updateCanvasSize(); this.draw(); }
    });
  }

  private createTensionPose(): Bone {
    const pose = this.deepClone(this.initialSkeleton);
    
    // Arms straight up for maximum tension
    this.findBone(pose, 'L_Shoulder')!.angle = Math.PI / 2;
    this.findBone(pose, 'R_Shoulder')!.angle = -Math.PI / 2;
    this.findBone(pose, 'L_Forearm')!.angle = 0;
    this.findBone(pose, 'R_Forearm')!.angle = 0;

    // Legs straight and angled inward to meet at the center
    const legAngle = Math.atan((ANATOMICAL_SCALE * 0.5) / (ANATOMICAL_SCALE * 1.75 + ANATOMICAL_SCALE * 1.75));
    this.findBone(pose, 'L_Hip')!.angle = legAngle;
    this.findBone(pose, 'R_Hip')!.angle = -legAngle;
    this.findBone(pose, 'L_Calf')!.angle = 0;
    this.findBone(pose, 'R_Calf')!.angle = 0;

    // Adjust feet to remain flat on the ground by counter-rotating the leg angle
    this.findBone(pose, 'L_Foot')!.angle = -legAngle;
    this.findBone(pose, 'R_Foot')!.angle = legAngle;

    return pose;
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.ctx = canvas.getContext('2d');
    if (this.ctx) {
        this.resizeObserver.observe(canvas.parentElement!);
        this.updateCanvasSize();
        this.draw();
    }
    window.addEventListener('keydown', this.handleKeyDown);
  }
  
  ngOnDestroy(): void {
    this.resizeObserver.disconnect();
    this.cancelPress();
    window.removeEventListener('keydown', this.handleKeyDown);
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  gameLoop = (timestamp: number): void => {
      if (this.lastTimestamp === 0) this.lastTimestamp = timestamp;
      const deltaTime = (timestamp - this.lastTimestamp) / 1000;
      this.lastTimestamp = timestamp;

      if (this.animationState().active) {
        this.updateTransitionAnimation();
      } else {
        this.updatePhysics(deltaTime);
      }
      this.draw();
      
      this.animationFrameId = requestAnimationFrame(this.gameLoop);
  }

  private updatePhysics(deltaTime: number): void {
      if (this.motionMode() === 'Collapse') {
          this.updateCollapse(deltaTime);
      }
  }

  private updateCollapse(deltaTime: number): void {
      const gravity = 9.8 * 100 * deltaTime * deltaTime;
      const floorY = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect().height * 0.85;

      for (const p of this.physicsPoints) {
          if (!p.isPinned) {
              const velX = p.x - p.oldX;
              const velY = p.y - p.oldY;
              p.oldX = p.x;
              p.oldY = p.y;
              p.x += velX;
              p.y += velY;
              p.y += gravity;
          }
      }

      for (let i = 0; i < 5; i++) {
          for (const s of this.physicsSticks) {
              const dx = s.p1.x - s.p0.x;
              const dy = s.p1.y - s.p0.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist === 0) continue;
              const diff = s.length - dist;
              const percent = diff / dist / 2;
              const offsetX = dx * percent;
              const offsetY = dy * percent;

              if (!s.p0.isPinned) { s.p0.x -= offsetX; s.p0.y -= offsetY; }
              if (!s.p1.isPinned) { s.p1.x += offsetX; s.p1.y += offsetY; }
          }
      }
      
      for (const p of this.physicsPoints) {
        if (p.y > floorY) p.y = floorY;
      }
  }

  startAnimation(targetSkeleton: Bone, targetMode: 'T-Pose' | 'Tension', durationFrames = 30): void {
    if (this.motionMode() === 'Collapse') {
      this.updateSkeletonAnglesFromPhysics();
    }
    
    this.animationState.set({
      active: true,
      startSkeleton: this.deepClone(this.skeleton()),
      targetSkeleton: targetSkeleton,
      startOffsets: { x: this.navelOffsetX(), y: this.navelOffsetY() },
      targetOffsets: { x: 0, y: 0 },
      durationFrames: durationFrames,
      currentFrame: 0,
      targetMode: targetMode
    });

    if (!this.animationFrameId) {
      this.lastTimestamp = 0;
      this.animationFrameId = requestAnimationFrame(this.gameLoop);
    }
  }

  private updateTransitionAnimation(): void {
    const state = this.animationState();
    if (!state.active) return;

    const newFrame = state.currentFrame + 1;
    const progress = newFrame / state.durationFrames;
    const lerp = (start: number, end: number, amt: number) => (1 - amt) * start + amt * end;

    const lerpSkeleton = (current: Bone, start: Bone, target: Bone) => {
        current.angle = lerp(start.angle, target.angle, progress);
        for (let i = 0; i < current.children.length; i++) {
            lerpSkeleton(current.children[i], start.children[i], target.children[i]);
        }
    };
    
    this.skeleton.update(s => {
        const newSkel = this.deepClone(s);
        lerpSkeleton(newSkel, state.startSkeleton!, state.targetSkeleton!);
        return newSkel;
    });

    this.navelOffsetX.set(lerp(state.startOffsets.x, state.targetOffsets.x, progress));
    this.navelOffsetY.set(lerp(state.startOffsets.y, state.targetOffsets.y, progress));

    if (newFrame >= state.durationFrames) {
      this.skeleton.set(this.deepClone(state.targetSkeleton!));
      this.motionMode.set(state.targetMode!);
      this.animationState.set({ ...state, active: false });
      if (this.animationFrameId) {
          cancelAnimationFrame(this.animationFrameId);
          this.animationFrameId = null;
      }
    } else {
      this.animationState.update(s => ({ ...s, currentFrame: newFrame }));
    }
  }

  // Exposed for the UI to trigger collapse, if a button were to be re-added.
  setCollapseMode(): void {
    this.motionMode.set('Collapse');
    this.initializeCollapseFromCurrentPose({ x: 0, y: 0 });
    if (!this.animationFrameId) {
      this.lastTimestamp = 0;
      this.animationFrameId = requestAnimationFrame(this.gameLoop);
    }
  }

  private updateSkeletonAnglesFromPhysics(): void {
      const skel = this.skeleton();
      const boneAngles = new Map<string, number>();

      const calculateGlobalAngle = (boneName: string): number => {
          if (boneAngles.has(boneName)) return boneAngles.get(boneName)!;
          const points = this.boneToPointsMap.get(boneName);
          if (!points) return 0;
          const {p0, p1} = points;
          const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          boneAngles.set(boneName, angle);
          return angle;
      };

      const traverse = (bone: Bone, parentGlobalAngle: number) => {
          const globalAngle = calculateGlobalAngle(bone.name);
          bone.angle = globalAngle - parentGlobalAngle;
          bone.children.forEach(child => traverse(child, globalAngle));
      };

      const navelPoints = this.boneToPointsMap.get('Navel');
      const navelAngle = navelPoints ? Math.atan2(navelPoints.p1.y - navelPoints.p0.y, navelPoints.p1.x - navelPoints.p0.x) : 0;
      traverse(skel, navelAngle);
      this.skeleton.set(skel);
  }

  private initializeCollapseFromCurrentPose(initialVelocity: { x: number; y: number }): void {
      this.physicsPoints = [];
      this.physicsSticks = [];
      this.boneToPointsMap.clear();
      const pointMap = new Map<string, PhysicsPoint>();

      const frameSkeleton = this.deepClone(this.skeleton());
      const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect();
      const floorY = parentRect.height * 0.85;
      const navelX = parentRect.width / 2 + this.navelOffsetX();
      const initialNavelY = (floorY - this.getLegLength()) - this.navelOffsetY();
      computeGlobalPositions(frameSkeleton, navelX, initialNavelY, 0);

      const getOrCreatePoint = (pos: {x: number, y: number}): PhysicsPoint => {
        const key = `${pos.x.toFixed(2)},${pos.y.toFixed(2)}`;
        if (pointMap.has(key)) return pointMap.get(key)!;
        
        const newPoint: PhysicsPoint = {
            x: pos.x, y: pos.y, 
            oldX: pos.x - initialVelocity.x * (1/60),
            oldY: pos.y - initialVelocity.y * (1/60),
            isPinned: false
        };
        pointMap.set(key, newPoint);
        this.physicsPoints.push(newPoint);
        return newPoint;
      };

      const processBone = (bone: Bone) => {
          if (bone.globalPos) {
              const p0 = getOrCreatePoint(bone.globalPos.start);
              const p1 = getOrCreatePoint(bone.globalPos.end);
              this.boneToPointsMap.set(bone.name, { p0, p1 });
              if (bone.length > 0) {
                this.physicsSticks.push({ p0, p1, length: bone.length });
              }
          }
          bone.children.forEach(processBone);
      };

      processBone(frameSkeleton);
  }
  
  private radToDeg(rad: number): number { return rad * (180 / Math.PI); }
  private degToRad(deg: number): number { return deg * (Math.PI / 180); }
  private createVisibleSkeleton(bone: Bone): Bone { const newBone: Bone = { ...bone, visible: true }; newBone.children = bone.children.map(child => this.createVisibleSkeleton(child)); return newBone; }
  toggleCharacterSheetView(): void { this.showCharacterSheet.update(v => !v); }
  private updateCanvasSize(): void { const canvas = this.canvasRef().nativeElement; const dpr = window.devicePixelRatio || 1; const rect = canvas.parentElement!.getBoundingClientRect(); canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; this.ctx!.scale(dpr, dpr); canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`; }
  private deepClone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)); }
  findBone(bone: Bone, name: string): Bone | null { if (bone.name === name) return bone; for (const child of bone.children) { const found = this.findBone(child, name); if (found) return found; } return null; }
  getBoneAngle(name: string): number { const bone = this.findBone(this.skeleton(), name); return bone ? bone.angle : 0; }
  getBoneAngleInDegrees(name: string): number { return Math.round(this.radToDeg(this.getBoneAngle(name))); }
  isBoneVisible(boneName: string): boolean { const bone = this.findBone(this.skeleton(), boneName); return bone?.visible ?? true; }
  
  setBoneAngle(name: string, event: Event, unit: 'rad' | 'deg'): void {
    const target = event.target as HTMLInputElement;
    let angleInRad = parseFloat(target.value);
    const isSlider = event.type === 'input';

    if (unit === 'deg') { angleInRad = this.degToRad(angleInRad); }

    this.skeleton.update(currentSkeleton => {
      const newSkeleton = this.deepClone(currentSkeleton);
      const boneToUpdate = this.findBone(newSkeleton, name);
      if (boneToUpdate) {
        const meta = this.boneMetadata.get(name);
        if (meta && isSlider) {
          boneToUpdate.angle = Math.max(meta.min, Math.min(meta.max, angleInRad));
        } else {
          boneToUpdate.angle = angleInRad;
        }
      }
      return newSkeleton;
    });

    const group = this.controlGroups.find(g => g.bones.includes(name)) || this.lockedBones().has(name);
    if (group) { this.lastAdjustedGroup.set(typeof group === 'object' ? group.name : name); }
  }
  
  getAnchorValue(name: 'Ground X' | 'Ground Y' | 'Global Rotation'): number {
    if (name === 'Ground X') return this.navelOffsetX();
    if (name === 'Ground Y') return this.navelOffsetY();
    return this.getBoneAngle('Navel');
  }

  setAnchorValue(name: 'Ground X' | 'Ground Y' | 'Global Rotation', event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    if (name === 'Ground X') this.navelOffsetX.set(value);
    else if (name === 'Ground Y') this.navelOffsetY.set(value);
    else if (name === 'Global Rotation') this.setBoneAngle('Navel', event, 'rad');
    
    this.lastAdjustedGroup.set('Core');
  }

  resetToTPose(): void {
    this.skeleton.set(this.deepClone(this.initialSkeleton));
    this.navelOffsetX.set(0);
    this.navelOffsetY.set(0);
    this.showCharacterSheet.set(false);
    this.clearAllLocks();
    this.motionMode.set('T-Pose');
    this.animationState.set({ ...this.animationState(), active: false });
  }

  clearAllLocks(): void {
    this.lockedBones.set(new Map());
  }
  
  resetGroup(groupName: string): void {
    const group = this.controlGroups.find(g => g.name === groupName);
    if (!group) return;

    this.lockedBones.update(locks => {
        const newLocks = new Map(locks);
        this.getBonesInGroup(groupName).forEach(boneName => newLocks.delete(boneName));
        return newLocks;
    });

    const bonesToReset = group.bones.filter(b => this.boneMetadata.has(b));
    const skel = this.skeleton();
    const targetPose = this.motionMode() === 'Tension' ? this.tensionPoseSkeleton : this.initialSkeleton;

    bonesToReset.forEach(boneName => {
        const bone = this.findBone(skel, boneName);
        const targetBone = this.findBone(targetPose, boneName);
        if (bone && targetBone) bone.angle = targetBone.angle;
    });

    this.skeleton.set(skel);
  }
  
  setActiveControl = (name: string | null) => this.activeControl.set(name);

  handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '`') { const lastGroup = this.lastAdjustedGroup(); if (lastGroup) this.resetGroup(lastGroup); return; }
    if (this.motionMode() === 'Collapse' || this.animationState().active) return;
    const activeCtrl = this.activeControl();
    if (!activeCtrl || this.isBoneInLockedChain(activeCtrl, false)) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const meta = this.boneMetadata.get(activeCtrl);
      const isAnchor = ['Ground X', 'Ground Y', 'Global Rotation'].includes(activeCtrl);
      const step = meta ? meta.step : 1;
      const delta = (event.key === 'ArrowUp' ? step : -step) * (isAnchor ? 1 : 0.01);
      
      if (isAnchor) {
        if (activeCtrl === 'Ground X') this.navelOffsetX.update(v => v + delta);
        else if (activeCtrl === 'Ground Y') this.navelOffsetY.update(v => v + delta);
        else if (activeCtrl === 'Global Rotation') this.skeleton.update(s => { const n = this.findBone(s,'Navel'); if(n) n.angle += delta; return s; });
      } else {
        this.skeleton.update(skel => { const b = this.findBone(skel, activeCtrl); if (b) b.angle += delta; return skel; });
      }
    }
  }

  toggleLock(boneName: string): void {
    if (!this.lockableBones.includes(boneName)) return;

    this.lockedBones.update(locks => {
      const newLocks = new Map(locks);
      if (newLocks.has(boneName)) {
        newLocks.delete(boneName);
      } else {
        const tempSkel = this.deepClone(this.skeleton());
        const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect();
        const floorY = parentRect.height * 0.85;
        const navelX = parentRect.width / 2 + this.navelOffsetX();
        const navelY = floorY - this.getLegLength() - this.navelOffsetY();
        computeGlobalPositions(tempSkel, navelX, navelY, 0);

        const parentBone = this.findParentBone(tempSkel, boneName);
        if (parentBone && parentBone.globalPos) {
          newLocks.set(boneName, { position: { ...parentBone.globalPos.end } });
        }
      }
      return newLocks;
    });
  }

  isBoneInLockedChain(boneName: string, checkEndEffector: boolean = true): boolean {
    if (!checkEndEffector && this.lockedBones().has(boneName)) return false;
    return this.lockedChainCache.has(boneName);
  }
  
  private solveTwoBoneIK(root: Bone, endEffectorName: string, targetPos: { x: number, y: number }): void {
    const chainNames = this.getIKChainNames(endEffectorName);
    if (!chainNames || chainNames.length !== 2) return;

    const bone1 = this.findBone(root, chainNames[0])!;
    const bone2 = this.findBone(root, chainNames[1])!;
    const parentOfBone1 = this.findParentBone(root, bone1.name)!;

    computeGlobalPositions(root, root.globalPos!.start.x, root.globalPos!.start.y, 0);
    
    const l1 = bone1.length;
    const l2 = bone2.length;
    const chainRootPos = parentOfBone1.globalPos!.end;

    const dx = targetPos.x - chainRootPos.x;
    const dy = targetPos.y - chainRootPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > l1 + l2) {
        const angleToTarget = Math.atan2(dy, dx);
        bone1.angle = angleToTarget - (parentOfBone1.globalAngle || 0);
        bone2.angle = 0;
        return;
    }

    const distSq = dist * dist;
    const angle1_num = (distSq + l1 * l1 - l2 * l2);
    const angle1_den = (2 * dist * l1);
    const angle1 = Math.acos(Math.max(-1, Math.min(1, angle1_num / angle1_den)));

    const angle2_num = (l1 * l1 + l2 * l2 - distSq);
    const angle2_den = (2 * l1 * l2);
    const angle2 = Math.acos(Math.max(-1, Math.min(1, angle2_num / angle2_den)));

    const bendDirection = (endEffectorName === 'L_Foot' || endEffectorName === 'L_Hand') ? -1 : 1;
    const angleToTarget = Math.atan2(dy, dx);
    
    const bone1GlobalAngle = angleToTarget + bendDirection * angle1;
    bone1.angle = bone1GlobalAngle - (parentOfBone1.globalAngle || 0);
    
    bone2.angle = bendDirection * (angle2 - Math.PI);
  }

  private solveAllIK(root: Bone, targets: Map<string, { position: { x: number; y: number } }>): void {
    if (targets.size === 0) return;
    if (targets.has('L_Foot')) this.solveTwoBoneIK(root, 'L_Foot', targets.get('L_Foot')!.position);
    if (targets.has('R_Foot')) this.solveTwoBoneIK(root, 'R_Foot', targets.get('R_Foot')!.position);
    if (targets.has('L_Hand')) this.solveTwoBoneIK(root, 'L_Hand', targets.get('L_Hand')!.position);
    if (targets.has('R_Hand')) this.solveTwoBoneIK(root, 'R_Hand', targets.get('R_Hand')!.position);
  }

  onPress(boneName: string): void { this.pressTimer = setTimeout(() => { this.isolateGroup(boneName); this.pressTimer = null; }, 500); }
  onRelease(boneName: string): void { if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; this.toggleBoneVisibility(boneName); } }
  cancelPress(): void { if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; } }
  private toggleBoneVisibility(boneName: string): void { this.skeleton.update(s => { const ns = this.deepClone(s); const b = this.findBone(ns, boneName); if (!b) return ns; const v = !b.visible; const setV = (bone: Bone) => { bone.visible = v; bone.children.forEach(setV); }; setV(b); return ns; }); }
  private isolateGroup(boneName: string): void { const groupName = this.boneToGroupMap[boneName]; if (!groupName) return; this.skeleton.update(s => { const ns = this.deepClone(s); const g = this.anatomicalGroups[groupName]; const setV = (bone: Bone) => { bone.visible = g.includes(bone.name); bone.children.forEach(setV); }; setV(ns); return ns; }); }
  private getBonesInGroup = (groupName: string): string[] => this.controlGroups.find(g => g.name === groupName)?.bones || [];
  private findParentBone = (root: Bone, childName: string): Bone | null => { let find = (b: Bone): Bone | null => { for (const child of b.children) { if (child.name === childName) return b; const found = find(child); if (found) return found; } return null; }; return find(root); }
  private getIKChainNames = (name:string): string[] | null => ({'R_Foot':['R_Hip','R_Calf'],'L_Foot':['L_Hip','L_Calf'],'R_Hand':['R_Shoulder','R_Forearm'],'L_Hand':['L_Shoulder','L_Forearm']})[name] || null;
  private buildLockedChainCache(root: Bone): void { this.lockedChainCache.clear(); this.lockedBones().forEach((_, name) => { const path = []; let current = this.findBone(root, name); while(current && current.name !== 'Navel') { path.push(current.name); current = this.findParentBone(root, current.name); } path.forEach(p => this.lockedChainCache.add(p)); }); }

  private draw(): void { 
    if (!this.ctx) return; 
    const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect(); 
    this.ctx.fillStyle = '#FDF6E3'; 
    this.ctx.fillRect(0, 0, parentRect.width, parentRect.height); 
    if (this.showCharacterSheet()) { 
        this.drawCharacterSheet(); 
    } else if (this.motionMode() === 'Collapse') {
        this.drawRagdoll();
    } else { 
        this.drawInteractiveModel();
    } 
  }
  
  private getLegLength(): number { return (this.findBone(SKELETON_TREE, 'Pelvis')!.length + this.findBone(SKELETON_TREE, 'L_Hip')!.length + this.findBone(SKELETON_TREE, 'L_Calf')!.length); }
  
  private drawInteractiveModel(): void {
    if (!this.ctx) return;
    const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect();
    const floorY = parentRect.height * 0.85;
    const navelX = parentRect.width / 2 + this.navelOffsetX();
    const initialNavelY = (floorY - this.getLegLength()) - this.navelOffsetY();

    const frameSkeleton = this.deepClone(this.skeleton());
    this.buildLockedChainCache(frameSkeleton);
    
    const ikTargets: Map<string, { position: { x: number; y: number; } }> = new Map(this.lockedBones());
    ikTargets.forEach((target, boneName) => {
        if (boneName.endsWith('Foot')) target.position.y = floorY;
    });

    frameSkeleton.globalPos = { start: { x: navelX, y: initialNavelY }, end: { x: navelX, y: initialNavelY } };
    
    if (ikTargets.size > 0) {
        this.solveAllIK(frameSkeleton, ikTargets);
    }
    
    computeGlobalPositions(frameSkeleton, navelX, initialNavelY, 0);
    this.drawGrid(parentRect.width, parentRect.height, navelX, floorY, initialNavelY);
    this.drawFloor(parentRect.width, parentRect.height);
    this.drawSkeleton(frameSkeleton);
  }

  private drawRagdoll(): void {
    if (!this.ctx || this.boneToPointsMap.size === 0) return;
    const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect();
    const floorY = parentRect.height * 0.85;
    const navelX = parentRect.width / 2;
    
    this.drawGrid(parentRect.width, parentRect.height, navelX, floorY);
    this.drawFloor(parentRect.width, parentRect.height);

    const physicsSkeleton: Bone = this.deepClone(this.initialSkeleton);
    const setPhysicsPositions = (bone: Bone) => {
        const points = this.boneToPointsMap.get(bone.name);
        if (points) {
            bone.globalPos = { start: points.p0, end: points.p1 };
        }
        bone.children.forEach(setPhysicsPositions);
    };
    setPhysicsPositions(physicsSkeleton);

    this.drawSkeleton(physicsSkeleton);
  }

  private drawSkeleton(root: Bone): void {
    if (!this.ctx) return;
    this.drawTorso(root); this.drawPelvis(root); this.drawNeck(root);
    const bonesToDraw: Bone[] = [];
    const flatten = (bone: Bone) => { bonesToDraw.push(bone); bone.children.forEach(flatten); };
    flatten(root);
    bonesToDraw.forEach(bone => {
      if (!bone.visible) return;
      const isLocked = this.isBoneInLockedChain(bone.name);
      const color = isLocked ? '#DC2626' : '#2E2E2E';
      switch(bone.name) {
        case 'L_Shoulder': case 'R_Shoulder': case 'L_Forearm': case 'R_Forearm':
        case 'L_Hip': case 'R_Hip': case 'L_Calf': case 'R_Calf': this.drawDiamond(bone, color); break;
        case 'L_Hand': case 'R_Hand': case 'L_Foot': case 'R_Foot': this.drawArrowhead(bone, color); break;
      }
    });
    const head = this.findBone(root, 'Head');
    if (head?.visible && head.globalPos) {
      this.ctx.fillStyle = '#2E2E2E';
      const { start } = head.globalPos;
      const radius = head.length / 3; 
      this.ctx.beginPath(); this.ctx.arc(start.x, start.y, radius, 0, Math.PI * 2); this.ctx.fill();
    }
    this.drawAllJoints(root);
  }

  private drawCharacterSheet(): void {
    if (!this.ctx) return;
    const parentRect = this.canvasRef().nativeElement.parentElement!.getBoundingClientRect();
    const { width, height } = parentRect;
    this.ctx.fillStyle = '#2E2E2E';
    this.ctx.strokeStyle = '#2E2E2E';
    this.ctx.font = '14px sans-serif';
    this.ctx.textAlign = 'center';

    const col1 = width * 0.2, col2 = width * 0.5, col3 = width * 0.8, row1 = height * 0.2, row2 = height * 0.6;

    const headData = this.findBone(SKELETON_TREE, 'Head')!;
    const headRadius = headData.length / 3;
    this.ctx.beginPath();
    this.ctx.arc(col3, row1, headRadius, 0, 2 * Math.PI);
    this.ctx.fill();
    this.ctx.fillText('Head', col3, row1 + headRadius + 20);

    const neckData = this.findBone(SKELETON_TREE, 'Neck')!;
    const neckH = neckData.length;
    const neckW = ANATOMICAL_SCALE * 0.5;
    const neckT = { x: col3, y: row2 - neckH / 2 }, neckBL = { x: col3 - neckW / 2, y: row2 + neckH / 2 }, neckBR = { x: col3 + neckW / 2, y: row2 + neckH / 2 };
    this.ctx.beginPath();
    this.ctx.moveTo(neckT.x, neckT.y);
    this.ctx.lineTo(neckBL.x, neckBL.y);
    this.ctx.lineTo(neckBR.x, neckBR.y);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.fillText('Neck', col3, row2 + neckH / 2 + 20);

    const shoulderW = ANATOMICAL_SCALE * 1.5;
    const torsoN = { x: col1, y: row1 + ANATOMICAL_SCALE * 0.75 };
    const torsoSL = { x: col1 - shoulderW / 2, y: row1 - ANATOMICAL_SCALE * 0.75 };
    const torsoSR = { x: col1 + shoulderW / 2, y: row1 - ANATOMICAL_SCALE * 0.75 };
    this.ctx.beginPath();
    this.ctx.moveTo(torsoN.x, torsoN.y);
    this.ctx.lineTo(torsoSL.x, torsoSL.y);
    this.ctx.lineTo(torsoSR.x, torsoSR.y);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.fillText('Torso', col1, torsoN.y + 20);

    const pelvisN = { x: col1, y: row2 - ANATOMICAL_SCALE * 0.5 };
    const hipW = ANATOMICAL_SCALE;
    const pelvisHL = { x: col1 - hipW / 2, y: row2 + ANATOMICAL_SCALE * 0.5 };
    const pelvisHR = { x: col1 + hipW / 2, y: row2 + ANATOMICAL_SCALE * 0.5 };
    const midX = (pelvisHL.x + pelvisHR.x) / 2, midY = (pelvisHL.y + pelvisHR.y) / 2;
    const controlY = midY + Math.abs(pelvisHR.x - pelvisHL.x) * 0.15;
    this.ctx.beginPath();
    this.ctx.moveTo(pelvisN.x, pelvisN.y);
    this.ctx.lineTo(pelvisHL.x, pelvisHL.y);
    this.ctx.quadraticCurveTo(midX, controlY, pelvisHR.x, pelvisHR.y);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.fillText('Pelvis', col1, controlY + 20);

    const shoulderData = this.findBone(SKELETON_TREE, 'L_Shoulder')!, forearmData = this.findBone(SKELETON_TREE, 'L_Forearm')!, handData = this.findBone(SKELETON_TREE, 'L_Hand')!;
    const shoulder: Bone = { ...this.deepClone(shoulderData), children: [], angle: 0, visible: true };
    const forearm: Bone = { ...this.deepClone(forearmData), children: [], angle: 0, visible: true };
    const hand: Bone = { ...this.deepClone(handData), children: [], angle: 0, visible: true };
    computeGlobalPositions(shoulder, col2 - (shoulder.length / 2), row1, 0);
    computeGlobalPositions(forearm, shoulder.globalPos!.end.x, shoulder.globalPos!.end.y, 0);
    computeGlobalPositions(hand, forearm.globalPos!.end.x, forearm.globalPos!.end.y, 0);
    this.drawDiamond(shoulder, '#2E2E2E');
    this.drawDiamond(forearm, '#2E2E2E');
    this.drawArrowhead(hand, '#2E2E2E');
    this.ctx.fillText('Arm', col2, hand.globalPos!.end.y + 30);

    const hipData = this.findBone(SKELETON_TREE, 'L_Hip')!, calfData = this.findBone(SKELETON_TREE, 'L_Calf')!, footData = this.findBone(SKELETON_TREE, 'L_Foot')!;
    const hip: Bone = { ...this.deepClone(hipData), children: [], angle: 0, visible: true };
    const calf: Bone = { ...this.deepClone(calfData), children: [], angle: 0, visible: true };
    const foot: Bone = { ...this.deepClone(footData), children: [], angle: 0, visible: true };
    const legStart = { x: col2, y: row2 - ANATOMICAL_SCALE * 1.5 };
    computeGlobalPositions(hip, legStart.x, legStart.y, Math.PI / 2);
    computeGlobalPositions(calf, hip.globalPos!.end.x, hip.globalPos!.end.y, Math.PI / 2);
    computeGlobalPositions(foot, calf.globalPos!.end.x, calf.globalPos!.end.y, Math.PI);
    this.drawDiamond(hip, '#2E2E2E');
    this.drawDiamond(calf, '#2E2E2E');
    this.drawArrowhead(foot, '#2E2E2E');
    this.ctx.fillText('Leg', col2, calf.globalPos!.end.y + 30);
  }

  private drawGrid(w: number, h: number, oX: number, fY: number, oY?: number): void {
    if (!this.ctx) return;

    const headHeight = ANATOMICAL_SCALE; // Major grid lines are scaled to one head unit.
    const minorGridSize = 10; // Minor grid lines for high-frequency sub-grid.
    this.ctx.lineWidth = 1;

    // 1. High-Frequency Sub-Grid (Minor Lines)
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)'; // Lighter opacity for sub-grid
    for (let x = 0.5; x < w; x += minorGridSize) {
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, h);
        this.ctx.stroke();
    }
    for (let y = 0.5; y < h; y += minorGridSize) {
        this.ctx.beginPath();
        this.ctx.moveTo(0, y);
        this.ctx.lineTo(w, y);
        this.ctx.stroke();
    }

    // 2. Anatomical Grid (Major Lines)
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    // Vertical major lines from origin
    for (let x = oX + 0.5; x <= w; x += headHeight) {
        this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, h); this.ctx.stroke();
    }
    for (let x = oX + 0.5; x >= 0; x -= headHeight) {
        this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, h); this.ctx.stroke();
    }
    // Horizontal major lines from origin (navel or floor)
    const startY = oY ?? fY;
    for (let y = startY + 0.5; y >= 0; y -= headHeight) {
        this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(w, y); this.ctx.stroke();
    }
    for (let y = startY + 0.5; y <= h; y += headHeight) {
        this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(w, y); this.ctx.stroke();
    }

    // 3. Dynamic Zero-Point (Dark Vertical Center Line)
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    this.ctx.beginPath();
    this.ctx.moveTo(oX + 0.5, 0);
    this.ctx.lineTo(oX + 0.5, h);
    this.ctx.stroke();
  }

  private drawFloor(w: number, h: number): void {
    if (!this.ctx) return;
    this.ctx.strokeStyle = '#4A90E2';
    this.ctx.lineWidth = 2;
    const fY = h * 0.85;
    this.ctx.beginPath();
    this.ctx.moveTo(0, fY);
    this.ctx.lineTo(w, fY);
    this.ctx.stroke();
  }

  private drawTorso(r: Bone): void {
    if (!this.ctx) return;
    const bone = this.findBone(r, 'Torso');
    if (!bone?.visible) return;
    try {
        const n = this.findBone(r, 'Navel')!, l = this.findBone(r, 'L_Shoulder')!, s = this.findBone(r, 'R_Shoulder')!;
        this.ctx.beginPath();
        this.ctx.moveTo(n.globalPos!.start.x, n.globalPos!.start.y);
        this.ctx.lineTo(l.globalPos!.start.x, l.globalPos!.start.y);
        this.ctx.lineTo(s.globalPos!.start.x, s.globalPos!.start.y);
        this.ctx.closePath();
        this.ctx.fillStyle = '#2E2E2E';
        this.ctx.fill();
    } catch (e) { /* ignore */ }
  }

  private drawPelvis(r: Bone): void {
    if (!this.ctx) return;
    const bone = this.findBone(r, 'Pelvis');
    if (!bone?.visible) return;
    try {
        const n = this.findBone(r, 'Navel')!, l = this.findBone(r, 'L_Hip')!, h = this.findBone(r, 'R_Hip')!;
        const p1 = n.globalPos!.start, p2 = l.globalPos!.start, p3 = h.globalPos!.start;
        const mX = (p2.x + p3.x) / 2, mY = (p2.y + p3.y) / 2;
        const cY = mY + Math.abs(p3.x - p2.x) * 0.15;
        this.ctx.beginPath();
        this.ctx.moveTo(p1.x, p1.y);
        this.ctx.lineTo(p2.x, p2.y);
        this.ctx.quadraticCurveTo(mX, cY, p3.x, p3.y);
        this.ctx.closePath();
        this.ctx.fillStyle = '#2E2E2E';
        this.ctx.fill();
    } catch (e) { /* ignore */ }
  }

  private drawNeck(r: Bone): void {
    if (!this.ctx) return;
    const bone = this.findBone(r, 'Neck');
    if (!bone?.visible) return;
    try {
        const h = this.findBone(r, 'Head')!, l = this.findBone(r, 'L_Shoulder')!, s = this.findBone(r, 'R_Shoulder')!, t = this.findBone(r, 'Torso')!;
        const hB = h.globalPos!.start, lP = l.globalPos!.start, sP = s.globalPos!.start, tT = t.globalPos!.end;
        const oL = { x: (lP.x + tT.x) / 2, y: (lP.y + tT.y) / 2 }, oR = { x: (sP.x + tT.x) / 2, y: (sP.y + tT.y) / 2 };
        const bM = { x: (oL.x + oR.x) / 2, y: (oL.y + oR.y) / 2 };
        const rF = 1 / 3;
        const nL = { x: bM.x + (oL.x - bM.x) * rF, y: bM.y + (oL.y - bM.y) * rF }, nR = { x: bM.x + (oR.x - bM.x) * rF, y: bM.y + (oR.y - bM.y) * rF };
        this.ctx.beginPath();
        this.ctx.moveTo(nL.x, nL.y);
        this.ctx.lineTo(nR.x, nR.y);
        this.ctx.lineTo(hB.x, hB.y);
        this.ctx.closePath();
        this.ctx.fillStyle = '#2E2E2E';
        this.ctx.fill();
    } catch (e) { /* ignore */ }
  }

  private drawDiamond(b: Bone, c: string): void {
    if (!this.ctx || !b.globalPos || !b.visible) return;
    const { start: s, end: e } = b.globalPos;
    const w = b.mass * 2.5;
    const dX = e.x - s.x, dY = e.y - s.y;
    const l = Math.sqrt(dX * dX + dY * dY);
    if (l === 0) return;
    const pDx = -dY / l, pDy = dX / l;
    const mX = s.x + dX * 0.33, mY = s.y + dY * 0.33;
    const p1x = mX + pDx * w / 2, p1y = mY + pDy * w / 2, p2x = mX - pDx * w / 2, p2y = mY - pDy * w / 2;
    this.ctx.beginPath();
    this.ctx.moveTo(s.x, s.y);
    this.ctx.lineTo(p1x, p1y);
    this.ctx.lineTo(e.x, e.y);
    this.ctx.lineTo(p2x, p2y);
    this.ctx.closePath();
    this.ctx.fillStyle = c;
    this.ctx.fill();
  }

  private drawArrowhead(bone: Bone, color: string): void {
    if (!this.ctx || !bone.globalPos || !bone.visible) return;
    const { start, end } = bone.globalPos;
    const arrowWidth = bone.length * 0.25;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const perpDx = -dy / len;
    const perpDy = dx / len;
    const p1x = start.x + perpDx * arrowWidth / 2;
    const p1y = start.y + perpDy * arrowWidth / 2;
    const p2x = start.x - perpDx * arrowWidth / 2;
    const p2y = start.y - perpDy * arrowWidth / 2;
    this.ctx.beginPath();
    this.ctx.moveTo(end.x, end.y);
    this.ctx.lineTo(p1x, p1y);
    this.ctx.lineTo(p2x, p2y);
    this.ctx.closePath();
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  private drawAllJoints(root: Bone): void {
    if (!this.ctx) return;
    const bones: Bone[] = [];
    const flatten = (bone: Bone) => {
        if (bone.visible) {
            bones.push(bone);
            bone.children.forEach(flatten);
        }
    };
    flatten(root);
    bones.forEach(bone => {
        if (bone.globalPos) {
            const { start } = bone.globalPos;
            const jointsToHide = ['Neck', 'L_Clavicle', 'R_Clavicle', 'Head', 'Navel', 'L_Hand', 'R_Hand', 'L_Foot', 'R_Foot'];
            if (!jointsToHide.includes(bone.name)) {
                this.ctx.beginPath();
                this.ctx.fillStyle = '#2E2E2E';
                this.ctx.arc(start.x, start.y, 4, 0, 2 * Math.PI);
                this.ctx.fill();
            }
            if (bone.children.length === 0 && !jointsToHide.includes(bone.name)) {
                const { end } = bone.globalPos;
                this.ctx.beginPath();
                this.ctx.fillStyle = '#2E2E2E';
                this.ctx.arc(end.x, end.y, 4, 0, 2 * Math.PI);
                this.ctx.fill();
            }
        }
    });
  }
}