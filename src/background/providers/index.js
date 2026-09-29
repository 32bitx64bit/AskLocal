import { api } from "../api.js";
import {
  callOpenAICompatible
} from "../providers/openai-compatible.js";

export async function callProvider(settings, prompt, context, progress) {
  return callOpenAICompatible(settings, prompt, context, progress);
}
