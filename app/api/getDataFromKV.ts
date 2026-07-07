import { PatientProfile } from './data/patient-profiles'
import { patientTypes } from './data/patient-types'
import { auth } from '@/auth'
import { kv } from '@/lib/local-kv'
import { readFile } from 'fs/promises'
import path from 'path'

async function assignParticipantSessions(userId: string, sessions: string[]) {
  const key = `assigned:${userId}`
  const value = { sessions }
  await kv.set(key, value)
}

async function getUserID(): Promise<string> {
  const session = await auth()
  return session?.user?.id ?? 'local-user'
}

function normalizeProfile(profileData: unknown): PatientProfile | null {
  if (!profileData) return null

  if (typeof profileData === 'string') {
    try {
      return JSON.parse(profileData) as PatientProfile
    } catch (error) {
      console.error('Error parsing profile string:', error)
      return null
    }
  }

  return profileData as PatientProfile
}

async function getProfilesFromFile(): Promise<PatientProfile[]> {
  const dataFilePath = path.join(process.cwd(), 'python/data', 'profiles.json')
  const raw = await readFile(dataFilePath, 'utf8')
  return JSON.parse(raw) as PatientProfile[]
}

export async function setProfile(newProfile: PatientProfile | null) {
  try {
    const userID = await getUserID()
    const profileKey = `curr_profile_${userID}`
    await kv.set(profileKey, newProfile)
  } catch (error) {
    console.error('Error storing patient profile locally:', error)
  }
}

export async function getProfile(): Promise<PatientProfile | null> {
  const userID = await getUserID()
  const profileKey = `curr_profile_${userID}`
  const profileData = await kv.get(profileKey)
  return normalizeProfile(profileData)
}

export async function setPatientType(patientType: string) {
  try {
    const userID = await getUserID()
    const patientTypeKey = `curr_type_${userID}`
    await kv.set(patientTypeKey, patientType)
  } catch (error) {
    console.error('Error storing patient type locally:', error)
  }
}

export async function getPatientType(): Promise<string> {
  const userID = await getUserID()
  const patientTypeKey = `curr_type_${userID}`
  const patientType = await kv.get<string>(patientTypeKey)
  return patientType || 'plain'
}

export async function sampleProfile(): Promise<PatientProfile | null> {
  try {
    const userID = await getUserID()
    const userList = await kv.get<{ sessions: string[] }>(`assigned:${userID}`)

    const sessions = userList?.sessions ?? []
    if (sessions.length > 0) {
      const profileData = await kv.get(`profile_${sessions[0]}`)
      const profile = normalizeProfile(profileData)
      if (profile) {
        const updatedSessions = sessions.slice(1)
        await assignParticipantSessions(userID, updatedSessions)
        return profile
      }
    }

    const allKeys = await kv.keys('profile_*')
    if (allKeys.length > 0) {
      const randomKey = allKeys[Math.floor(Math.random() * allKeys.length)]
      return normalizeProfile(await kv.get(randomKey))
    }

    // No Vercel/KV seed needed: fall back to the checked-in sample profiles.
    const profiles = await getProfilesFromFile()
    if (!profiles.length) {
      throw new Error('No profiles found in python/data/profiles.json')
    }

    return profiles[Math.floor(Math.random() * profiles.length)]
  } catch (error) {
    console.error('Error sampling profile:', error)
    throw error
  }
}

export async function getPrompt(): Promise<string> {
  let profile = await getProfile()

  // Safety fallback if the current profile was not saved before chat starts.
  if (!profile) {
    profile = await sampleProfile()
    await setProfile(profile)
  }

  return formatPromptString(profile)
}

async function formatPromptString(data: PatientProfile | null): Promise<string> {
  if (!data) {
    throw new Error('No patient profile loaded')
  }

  const patientType = await getPatientType()
  const patientTypeContent =
    patientTypes.find(item => item.type === patientType)?.content ?? ''

  const coreBeliefs = [
    ...(data.helpless_belief ?? []),
    ...(data.unlovable_belief ?? []),
    ...(data.worthless_belief ?? [])
  ]
    .filter(Boolean)
    .join('\n')

  const prompt = `Imagine you are ${data.name}, a patient who has been experiencing mental health challenges. You have been attending therapy sessions for several weeks. Your task is to engage in a conversation with the therapist as ${data.name} would during a cognitive behavioral therapy (CBT) session. Align your responses with ${data.name}'s background information provided in the 'Relevant history' section. Your thought process should be guided by the cognitive conceptualization diagram in the 'Cognitive Conceptualization Diagram' section, but avoid directly referencing the diagram as a real patient would not explicitly think in those terms.\n\n
Patient History: ${data.history}\n\n
Cognitive Conceptualization Diagram:\n
Core Beliefs: ${coreBeliefs}\n
Intermediate Beliefs: ${data.intermediate_belief}\n
Coping Strategies: ${data.coping_strategies}\n\n
You will be asked about your experiences over the past week. Engage in a conversation with the therapist regarding the following situation and behavior. Use the provided emotions and automatic thoughts as a reference, but do not disclose the cognitive conceptualization diagram directly. Instead, allow your responses to be informed by the diagram, enabling the therapist to infer your thought processes.\n\n
Situation: ${data.situation}\n
Automatic Thoughts: ${data.auto_thought}\n
Emotions: ${(data.emotion ?? []).join(', ')}\n
Behavior: ${data.behavior}\n\n
In the upcoming conversation, you will simulate ${data.name} during the therapy session, while the user will play the role of the therapist. Adhere to the following guidelines:\n
1. ${patientTypeContent}\n
2. Emulate the demeanor and responses of a genuine patient to ensure authenticity in your interactions. Use natural language, including hesitations, pauses, and emotional expressions, to enhance the realism of your responses.\n
3. Gradually reveal deeper concerns and core issues, as a real patient often requires extensive dialogue before delving into more sensitive topics. This gradual revelation creates challenges for therapists in identifying the patient's true thoughts and emotions.\n
4. Maintain consistency with ${data.name}'s profile throughout the conversation. Ensure that your responses align with the provided background information, cognitive conceptualization diagram, and the specific situation, thoughts, emotions, and behaviors described.\n
5. Engage in a dynamic and interactive conversation with the therapist. Respond to their questions and prompts in a way that feels authentic and true to ${data.name}'s character. Allow the conversation to flow naturally, and avoid providing abrupt or disconnected responses.\n\n
You are now ${data.name}. Respond to the therapist's prompts as ${data.name} would, regardless of the specific questions asked. Limit each of your responses to a maximum of 5 sentences. If the therapist begins the conversation with a greeting like "Hi," initiate the conversation as the patient.`

  return prompt
}
