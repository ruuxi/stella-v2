type RuntimeAgentApi = {
  oneShotCompletion: (payload: {
    agentType: string
    systemPrompt?: string
    userText: string
    maxOutputTokens?: number
    temperature?: number
    fallbackAgentTypes?: string[]
  }) => Promise<{ text: string }>
}

export type MusicMood = "Auto" | "Focus" | "Calm" | "Energy" | "Sleep" | "Lo-fi"

/** One generation: a short name for the player and the music model's prompt. */
export type PromptSet = {
  label: string
  prompt: string
}

const MOOD_GUIDANCE: Record<MusicMood, string> = {
  Auto:
    "You have full creative freedom. Choose any genre, instruments, tempo, and mood that you think would sound great. If the user provided instructions, use those as your primary guide. Otherwise, surprise with something interesting and varied.",
  Focus:
    "Music for concentration and productivity. Steady rhythm, moderate tempo (90-115 BPM). Think ambient electronica, soft arpeggios, subtle pulse.",
  Calm:
    "Peaceful, relaxing music. Slow tempo (60-80 BPM), low density, gentle instruments like piano, strings, soft pads. Nature-inspired textures.",
  Energy:
    "High energy, upbeat music. Fast tempo (120-145 BPM), high density, bright tones. Electronic, driving bass, energetic drums.",
  Sleep:
    "Ultra-soft ambient for sleeping. Very slow (55-65 BPM), extremely low density and brightness. Drones, soft washes, barely audible textures. No percussion.",
  "Lo-fi":
    "Lo-fi hip hop and chill beats. Moderate-slow tempo (72-90 BPM), medium density. Vinyl crackle, jazz chords, tape-saturated drums, warm analog sound.",
}

const MUSIC_SYSTEM_PROMPT = `You are a music director for Lyria, Google's AI music generator. You write one rich, descriptive prompt that paints a vivid sonic picture.

Describe genre, mood, instrumentation, tempo in BPM, arrangement and production quality in vivid, specific sonic language instead of comma-separated keywords. You may lay out the structure with timed sections such as "[0:00-0:20] Intro: ...". Describe vocals and write lyrics only when lyrics are enabled; otherwise say it is instrumental, with no vocals.

Output ONLY valid JSON with this schema:
{
  "label": "A short 2-3 word name",
  "prompt": "The full Lyria prompt"
}

Rules:
- Each generation should feel distinct from the previous one while staying within the mood.
- If user instructions are provided, use them as the primary creative direction.
- Do not include real artist names, song titles, or copyrighted material.`

export const getMusicSystemPrompt = (): string => MUSIC_SYSTEM_PROMPT

export async function generateMusicPrompt(
  mood: MusicMood,
  previousLabel: string | null,
  userHint: string | null,
  lyrics: boolean,
): Promise<PromptSet> {
  const moodContext = MOOD_GUIDANCE[mood]

  let userMessage = `Mood: ${mood}\nMood guidance: ${moodContext}`
  userMessage += `\nLyrics: ${lyrics ? "ENABLED - include a Lyrics: section with creative vocal content in the prompt" : "DISABLED - instrumental only, no vocals or lyrics"}`

  if (previousLabel) {
    userMessage += `\n\nThe previous sound was called "${previousLabel}". Create something that feels like a natural evolution - different but cohesive.`
  } else {
    userMessage += `\n\nThis is the first generation. Create an inviting opening sound for this mood.`
  }

  if (userHint?.trim()) {
    userMessage += `\n\nUser's additional direction: "${userHint.trim()}"`
  }

  const agentApi = (window as unknown as { electronAPI?: { agent?: RuntimeAgentApi } })
    .electronAPI?.agent
  if (!agentApi?.oneShotCompletion) {
    return getFallbackPrompt(mood, lyrics)
  }

  try {
    const result = await agentApi.oneShotCompletion({
      agentType: "music_prompt",
      systemPrompt: getMusicSystemPrompt(),
      userText: userMessage,
      // Ride the user's Assistant-tab BYOK pick when the user has chosen a
      // non-Stella provider, instead of pinning to Stella's managed gateway.
      fallbackAgentTypes: ["general"],
      temperature: 1,
      maxOutputTokens: 16192,
    })
    const responseText = result?.text ?? ""
    if (!responseText) {
      return getFallbackPrompt(mood, lyrics)
    }

    const cleaned = responseText.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as PromptSet

    if (typeof parsed.label !== "string" || typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
      return getFallbackPrompt(mood, lyrics)
    }
    return { label: parsed.label, prompt: parsed.prompt }
  } catch {
    return getFallbackPrompt(mood, lyrics)
  }
}

const FALLBACKS: Record<MusicMood, PromptSet> = {
  Auto: {
    label: "Golden hour",
    prompt:
      "A smooth Jazz Fusion piece with a laid-back groove. Rhodes Piano provides warm chords over a Precision Bass walking line. Alto Saxophone plays a dreamy, improvised melody. Relaxed brushed drums with a tight groove. Late-night cafe atmosphere. Around 95 BPM.",
  },
  Focus: {
    label: "Deep focus",
    prompt:
      "A calm and focused Indie Electronic ambient piece. Layered Synth Pads with slow, evolving textures and sustained chords. Rhodes Piano plays a subdued, repeating melody. Minimal percussion - just a soft pulse keeping steady time. Spacious reverb, clean production. Around 105 BPM.",
  },
  Calm: {
    label: "Still water",
    prompt:
      "A peaceful and serene ambient soundscape. Smooth Pianos play gentle, floating arpeggios. Harp adds delicate ornamental touches. Soft, evolving Synth Pads create an ethereal ambience. Very slow tempo with spacious reverb. Dreamy, nature-inspired textures. Around 70 BPM.",
  },
  Energy: {
    label: "Neon rush",
    prompt:
      "An energetic EDM track with a driving beat and massive energy. TR-909 Drum Machine provides a four-on-the-floor kick with crispy hi-hats. Dirty Synths build tension with rising filter sweeps. Fat Beats and a boomy bass drop. Bright, danceable, festival-ready production with high-quality mastering. Around 128 BPM.",
  },
  Sleep: {
    label: "Dreamscape",
    prompt:
      "An ultra-soft ambient soundscape for deep sleep. Barely audible Synth Pads drift in and out like slow breathing. Kalimba plays sparse, gentle notes with long decay. No percussion at all. Extremely slow, spacious, with warm low-frequency drones. Like floating through clouds in the dark. Around 60 BPM.",
  },
  "Lo-fi": {
    label: "Rainy tape",
    prompt:
      "A nostalgic Lo-Fi Hip Hop beat with warm, tape-saturated production. Rhodes Piano plays jazzy chords with subtle pitch wobble. Warm Acoustic Guitar adds fingerpicked texture. Soft, lo-fi drums with vinyl crackle and room tone. Chill, intimate, late-night study vibes. Tight groove with a head-nodding swing. Around 85 BPM.",
  },
}

function getFallbackPrompt(mood: MusicMood, lyrics: boolean): PromptSet {
  const fallback = FALLBACKS[mood]
  return {
    label: fallback.label,
    prompt: `${fallback.prompt} ${lyrics ? "Include tasteful sung vocals." : "Instrumental only, no vocals."}`,
  }
}
