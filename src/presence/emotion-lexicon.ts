import type { FreeWillStance } from '../soul/types.ts';

const NEGATED_POS_RE = /(不太开心|不开心|不高兴|不安心|不放心|不舒服|不安全|不轻松|not\s+happy|unhappy|not\s+safe|unsafe|not\s+calm|not\s+relaxed|uncomfortable)/i;
const SEVERE_NEG_RE = /(疼痛|痛|受伤|怕|害怕|恐|惊慌|炸|hurt|pain|terrified|scared|afraid|panic)/i;
const ANGRY_ANXIOUS_RE = /(生气|愤怒|恼火|烦躁|焦虑|焦躁|紧张|不安|警惕|戒备|犹豫|谨慎|防备|余悸|angry|mad|furious|annoyed|irritated|anxious|worried|nervous|tense|cautious|wary|stressed)/i;
const SAD_TIRED_RE = /(委屈|难过|低落|郁闷|失落|伤心|疲惫|沮丧|哭|sad|upset|down|depressed|lonely|tired|exhausted)/i;
const HIGH_POS_RE = /(雀跃|欣喜|开心|欢喜|明朗|兴奋|太棒|激动|happy|joy|excited|cheerful|delighted|thrilled|great)/i;
const WARM_POS_RE = /(温柔|安心|信赖|温暖|欣慰|惦记|思念|warm|gentle|safe|relieved|grateful|affectionate|tender|loving)/i;
const CALM_RE = /(平静|安静|沉静|专注|安稳|放松|calm|peaceful|focused|relaxed|quiet|steady)/i;

export function inferStimulusFromMoodText(
  rawMood?: string,
  stance?: FreeWillStance,
): { valence: number; arousal: number; safety: number; intensity: number } {
  const mood = String(rawMood ?? '').trim();
  let valence = 0.0;
  let arousal = 0.35;
  let safety = 0.65;
  let intensity = 0.22;

  if (NEGATED_POS_RE.test(mood)) {
    valence = -0.36; arousal = 0.56; safety = 0.38; intensity = 0.5;
  } else if (SEVERE_NEG_RE.test(mood)) {
    valence = -0.78; arousal = 0.85; safety = 0.16; intensity = 0.78;
  } else if (ANGRY_ANXIOUS_RE.test(mood)) {
    valence = -0.42; arousal = 0.7; safety = 0.28; intensity = 0.6;
  } else if (SAD_TIRED_RE.test(mood)) {
    valence = -0.52; arousal = 0.45; safety = 0.42; intensity = 0.52;
  } else if (HIGH_POS_RE.test(mood)) {
    valence = 0.68; arousal = 0.7; safety = 0.78; intensity = 0.56;
  } else if (WARM_POS_RE.test(mood)) {
    valence = 0.48; arousal = 0.42; safety = 0.78; intensity = 0.44;
  } else if (CALM_RE.test(mood)) {
    valence = 0.18; arousal = 0.28; safety = 0.72; intensity = 0.3;
  }

  if (stance === 'firm_refuse' || stance === 'negotiate_condition') {
    safety = Math.min(safety, 0.36);
    valence = Math.min(valence, -0.18);
    intensity = Math.max(intensity, 0.48);
  } else if (stance === 'invite_together') {
    safety = Math.min(safety, 0.52);
  } else if (stance === 'gladly_accept') {
    valence = Math.max(valence, 0.35);
    safety = Math.max(safety, 0.68);
  }
  return { valence, arousal, safety, intensity };
}
