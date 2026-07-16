// Round-announcement voice playback.
//
// Clips are pre-recorded mp3 files served from public/voice/. Playback uses the
// Web Audio API with buffers preloaded and decoded up front (instant playback,
// no per-announcement network fetch), and falls back to plain <audio> elements
// when Web Audio is unavailable or a buffer failed to preload.
//
// Mobile autoplay policies block sound until the page receives a user gesture,
// and the iOS hardware ring/silent switch additionally mutes Web Audio unless
// the page is treated as "playing media". unlockVoicePlayback() must therefore
// be called from a gesture handler: it resumes the AudioContext and loops an
// inaudible clip so announcements keep sounding even with the switch on.

const VOICE_BASE = `${import.meta.env.BASE_URL}voice/`;

export const VOICE_CLIP_NAMES = [
  ...Array.from({ length: 10 }, (_, total) => `xian${total}`),
  ...Array.from({ length: 10 }, (_, total) => `zhuang${total}`),
  "xianWin",
  "zhuangWin",
  "tie",
  "xianPair",
  "zhuangPair",
];

let audioContext: AudioContext | null = null;
const clipBuffers = new Map<string, AudioBuffer>();
let unlocked = false;
let keepAliveAudio: HTMLAudioElement | null = null;
let sequenceToken = 0;
let currentSource: AudioBufferSourceNode | null = null;
let currentAudio: HTMLAudioElement | null = null;

function clipUrl(name: string) {
  return `${VOICE_BASE}${name}.mp3`;
}

function getAudioContext() {
  if (audioContext) {
    return audioContext;
  }

  const Constructor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) {
    return null;
  }

  audioContext = new Constructor();
  return audioContext;
}

function decodeClip(context: AudioContext, data: ArrayBuffer) {
  // Older Safari only implements the callback form of decodeAudioData.
  return new Promise<AudioBuffer>((resolve, reject) => {
    void context.decodeAudioData(data, resolve, reject);
  });
}

export async function preloadVoiceClips(names: string[] = VOICE_CLIP_NAMES) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  await Promise.all(
    names.map(async (name) => {
      if (clipBuffers.has(name)) {
        return;
      }

      try {
        const response = await fetch(clipUrl(name));
        const buffer = await decodeClip(context, await response.arrayBuffer());
        clipBuffers.set(name, buffer);
      } catch {
        // ignore — playback falls back to <audio> for missing buffers
      }
    }),
  );
}

function resumeAfterBackgrounding() {
  if (document.visibilityState !== "visible") {
    return;
  }

  void getAudioContext()?.resume().catch(() => {});
  void keepAliveAudio?.play().catch(() => {});
}

export function unlockVoicePlayback() {
  if (unlocked) {
    return;
  }

  unlocked = true;

  const context = getAudioContext();
  if (context) {
    void context.resume().catch(() => {});
    try {
      // Playing an empty buffer inside the gesture unlocks the context.
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start(0);
    } catch {
      // ignore — priming is best-effort
    }
  }

  try {
    keepAliveAudio = new Audio(clipUrl("silence"));
    keepAliveAudio.loop = true;
    void keepAliveAudio.play().catch(() => {
      keepAliveAudio = null;
    });
  } catch {
    keepAliveAudio = null;
  }

  // iOS suspends the context and pauses media when the tab is backgrounded.
  document.addEventListener("visibilitychange", resumeAfterBackgrounding);
}

async function playBufferClip(context: AudioContext, buffer: AudioBuffer) {
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      // ignore — start() below still succeeds once the context recovers
    }
  }

  await new Promise<void>((resolve) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    currentSource = source;
    source.onended = () => {
      if (currentSource === source) {
        currentSource = null;
      }
      resolve();
    };

    try {
      source.start();
    } catch {
      resolve();
    }
  });
}

async function playAudioElementClip(name: string) {
  const audio = new Audio(clipUrl(name));
  currentAudio = audio;

  try {
    await audio.play();
  } catch {
    if (currentAudio === audio) {
      currentAudio = null;
    }
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      audio.removeEventListener("pause", done);
      resolve();
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    audio.addEventListener("pause", done);
  });

  if (currentAudio === audio) {
    currentAudio = null;
  }
}

export async function playVoiceClips(names: string[]) {
  if (!names.length) {
    return;
  }

  sequenceToken += 1;
  const token = sequenceToken;
  const context = getAudioContext();

  for (const name of names) {
    if (token !== sequenceToken) {
      return;
    }

    const buffer = clipBuffers.get(name);
    if (context && buffer) {
      await playBufferClip(context, buffer);
    } else {
      await playAudioElementClip(name);
    }
  }
}

export function stopVoicePlayback() {
  sequenceToken += 1;

  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // ignore — source may have already ended
    }
    currentSource = null;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}
