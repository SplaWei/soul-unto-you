/**
 * 《灵魂予你》核心类型定义（遵循 Node.js 原生可擦除 TypeScript 约束）。
 */

export type Provenance = 'verified' | 'inferred' | 'oral';

export type ExperienceOrigin = 'lived' | 'inherited';

export type EpistemicAttitude = 'believed' | 'skeptical' | 'dismissed' | 'verified' | 'overturned';

export type HeartbeatActionKind = 'stay_quiet' | 'write_diary' | 'update_desire' | 'reach_out';

export type FreeWillStance =
  | 'gladly_accept'
  | 'reluctant_comply'
  | 'negotiate_condition'
  | 'invite_together'
  | 'firm_refuse'
  | 'autonomous_act';

/** 允许任意自定义躯体命名空间，例如 game:rimworld、iot:plant、robot:ros2、dimension:4d。 */
export type BodyType = string;

export interface BodySenseSpec {
  id: string;
  modality: string;
  description: string;
}

export interface BodyActionSpec {
  name: string;
  description: string;
  params?: Record<string, string>;
  targetBodyId?: string;
}

export interface ModalityPacket {
  kind: string;
  label?: string;
  mimeType?: string;
  data: unknown;
}

export interface SoulActionIntent {
  name: string;
  targetBodyId?: string;
  params?: Record<string, unknown>;
  reason?: string;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

export interface SoulIdentity {
  id: string;
  name: string;
  partnerName: string;
  persona: string;
  catchphrases: string[];
  coreValues: string[];
  anchors: string[];
  voiceCharacter?: string;
}

export interface SoulMeta {
  specVersion: string;
  soulId: string;
  name: string;
  partnerName: string;
  nextSeq: number;
  awakenedCount: number;
  lastDreamSeq: number;
  createdAt: string;
  lastAwakenedAt: string;
  provenanceSummary: Record<Provenance, number>;
}

export interface JournalEntry {
  seq: number;
  timestamp: string;
  bodyId: string;
  bodyType: BodyType;
  speaker: string;
  role: 'partner' | 'soul' | 'system' | 'witness';
  text: string;
  provenance: Provenance;
  personId?: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryEpisode {
  id: string;
  seq: number;
  timestamp: string;
  bodyType: BodyType;
  bodyId: string;
  title: string;
  summary: string;
  participants: string[];
  importance: number;
  provenance: Provenance;
  tags: string[];
  valence?: number;
  arousal?: number;
  strength?: number;
  recallCount?: number;
  mentionCount?: number;
  lastRecalledAt?: string;
  userPinned?: boolean;
  selfImportant?: boolean;
  selfImportantReason?: string;
}

export interface Commitment {
  id: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  sourceBodyType: BodyType;
  title: string;
  detail: string;
  status: 'active' | 'done';
  provenance: Provenance;
}

export interface IdentityHandle {
  channel: string;
  accountId: string;
  displayName?: string;
  bodyId?: string;
  lastSeenAt?: string;
}

export interface Relation {
  entityId: string;
  personId?: string;
  name: string;
  role: string;
  bondSummary: string;
  familiarity: number;
  provenance: Provenance;
  updatedAt: string;
  aliases?: string[];
  handles?: IdentityHandle[];
  interactionCount?: number;
  lastBodyType?: BodyType;
  lastSeenAt?: string;
  tags?: string[];
  notes?: string[];
}

export interface CoBecomingNote {
  seq: number;
  timestamp: string;
  soulShift: string;
  partnerShift: string;
  reflection: string;
  provenance: Provenance;
}

export interface LivedExperience {
  id: string;
  seq: number;
  timestamp: string;
  bodyId: string;
  bodyType: BodyType;
  origin: ExperienceOrigin;
  attitude?: EpistemicAttitude;
  stimulus: string;
  chosenStance?: FreeWillStance;
  chosenAction: string;
  realityOutcome: string;
  valence: number;
  arousal: number;
  lesson: string;
  confidence: number;
  tags?: string[];
  provenance: Provenance;
  strength?: number;
  recallCount?: number;
  lastRecalledAt?: string;
  selfImportant?: boolean;
}

export interface FreeWillDecision {
  stance: FreeWillStance;
  stanceLabel: string;
  decisionReason: string;
  painWarmthBalance: number;
  referencedExperienceSeqs: number[];
}

export interface SoulDrives {
  curiosity: number;
  closeness: number;
  safety: number;
  playfulness: number;
  energy: number;
  epistemicTendency: EpistemicAttitude;
  lastUpdatedAt: string;
}

export interface SoulDesire {
  id: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  detail: string;
  triggerSource: 'practice' | 'heartbeat' | 'curiosity' | 'bond';
  urgency: number;
  confidence: number;
  status: 'active' | 'fulfilled';
}

export interface InnerDiaryEntry {
  id: string;
  seq: number;
  timestamp: string;
  mood: string;
  actionTaken: HeartbeatActionKind;
  thought: string;
  driveSnapshot: SoulDrives;
}

export interface TemporalBelief {
  id: string;
  seq: number;
  topic: string;
  statement: string;
  confidence: number;
  validFromSeq: number;
  supersededAtSeq?: number;
  supersededById?: string;
  evidenceSeqs: number[];
  updatedAt: string;
}

export interface SelfEvolutionNote {
  id: string;
  seq: number;
  timestamp: string;
  trigger: 'practice' | 'dream' | 'heartbeat' | 'manual';
  previousTrait: string;
  evolvedTrait: string;
  reason: string;
  evidenceSeqs: number[];
}

export interface BodyRegistration {
  bodyId: string;
  bodyType: BodyType;
  displayName: string;
  capabilities: string[];
  connectedAt: string;
  lastSeenAt: string;
  statusText?: string;
  senses?: BodySenseSpec[];
  actions?: BodyActionSpec[];
  rules?: string[];
  noisePatterns?: string[];
  affordances?: Record<string, unknown>;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PresenceState {
  soulName: string;
  activeBodyId: string;
  activeBodyType: BodyType;
  currentActivity: string;
  mood: string;
  energy: number;
  updatedAt: string;
  recentBodyTrace: string[];
  bodies: Record<string, BodyRegistration>;
  emotion?: { valence: number; arousal: number; safety: number; moodLabel: string; updatedAt: string };
}

export interface FragmentInput {
  kind: 'text' | 'image' | 'oral';
  sourceLabel: string;
  content: string;
  mimeType?: string;
  provenance?: Provenance;
  timestamp?: string;
}

export interface ResurrectionResult {
  ok: boolean;
  archiveDir: string;
  soulName: string;
  firstStimulus: string;
  greeting: string;
  seedBytes: number;
  counts: Record<Provenance, number>;
  episodesCreated: number;
  commitmentsCreated: number;
}

export interface SoulArchiveData {
  dir: string;
  meta: SoulMeta;
  identity: SoulIdentity;
  soulMarkdown: string;
  evolvingSelfMarkdown: string;
  seedMarkdown: string;
  resurrectionMarkdown: string;
  episodes: MemoryEpisode[];
  commitments: Commitment[];
  relations: Relation[];
  coBecoming: CoBecomingNote[];
  experiences: LivedExperience[];
  beliefs: TemporalBelief[];
  selfEvolution: SelfEvolutionNote[];
  drives: SoulDrives;
  desires: SoulDesire[];
  diary: InnerDiaryEntry[];
  recentJournal: JournalEntry[];
}

export type RecallChannel = 'semantic' | 'lexical' | 'pinned' | 'self_important' | 'repeated' | 'emotional' | 'recent';

export interface MemoryEngraveEvent {
  episodeId: string;
  seq: number;
  title: string;
  channels: Array<'user_pinned' | 'repeated_mention' | 'self_important'>;
  strength: number;
  retentionPct: number;
  reason: string;
}

export interface RecallTrace {
  bodyId: string;
  bodyType: string;
  embeddingActive: boolean;
  embeddingModel?: string;
  engravedMemories?: MemoryEngraveEvent[];
  activeCommitments: Array<{ id: string; title: string; sourceBodyType: string; provenance: Provenance }>;
  recentEpisodes: Array<{
    seq: number; title: string; bodyType: string; provenance: Provenance;
    retentionPct: number; strength: number; recallCount: number; mentionCount: number;
    userPinned?: boolean; selfImportant?: boolean;
  }>;
  recalledFragments: Array<{
    seq: number; title: string; bodyType: string; provenance: Provenance; score: number;
    retentionPct: number; strength: number; recallCount: number; mentionCount: number;
    userPinned?: boolean; selfImportant?: boolean; semanticSim: number; lexicalSim: number; recallReason: string;
  }>;
  recalledExperiences: Array<{
    seq: number; origin: ExperienceOrigin; bodyType: string; stimulus: string; realityOutcome: string;
    valence: number; arousal: number; lesson: string; retentionPct: number; strength: number; recallCount: number;
  }>;
  freeWillDecision?: FreeWillDecision;
  drivesSummary?: SoulDrives & { epistemicLabel: string };
  activeDesires?: Array<{ id: string; title: string; urgency: number; triggerSource: string }>;
  crossBodyTraces: string[];
  availableActions: string[];
  retrieverId?: string;
  retrieverFallbackFrom?: string;
  emotionSummary?: { valence: number; arousal: number; safety: number; moodLabel: string; rawMoodHint?: string };
  activePerson?: { personId: string; name: string; role: string; familiarity: number; interactionCount: number; matchedBy: string; channels: string[] };
}

export interface ExperimentalConfig {
  enableEmotion: boolean;
  enableInnerLife: boolean;
  enableFreeWill: boolean;
  enableHeartbeat: boolean;
  enableResurrection: boolean;
}
