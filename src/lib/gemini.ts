import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateCode(prompt: string, currentCode?: string) {
  const model = "gemini-flash-latest";
  
  const systemPrompt = `
    You are an expert frontend React developer.
    Your task is to generate a React component based on the user's request.
    
    Rules:
    1. The component must be the default export.
    2. If the user asks to modify existing code, you will be provided with the current code.
    3. Return the response as a JSON object with a "code" field containing the full component code.
    4. Do not include markdown formatting (like \`\`\`json). Just the raw JSON string.
    5. Ensure the code is complete and functional.
    6. Use standard HTML elements or standard React hooks.
  `;

  const userMessage = currentCode 
    ? `Update this code based on the request: "${prompt}".\n\nCurrent Code:\n${currentCode}`
    : `Create a React component for: "${prompt}"`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        { role: "user", parts: [{ text: systemPrompt + "\n\n" + userMessage }] }
      ],
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text;
    if (!text) return null;
    
    try {
      // Clean up the text before parsing
      const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
      const json = JSON.parse(cleanText);
      return json.code;
    } catch (e) {
      console.error("Failed to parse JSON", e);
      // Fallback: Try to extract code from markdown block if it's not JSON
      const match = text.match(/```(?:javascript|jsx|tsx)?\s*([\s\S]*?)\s*```/);
      if (match) return match[1];
      return text;
    }
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}
