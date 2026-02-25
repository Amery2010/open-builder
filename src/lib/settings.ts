// AI 配置设置
export interface AISettings {
  apiKey: string;
  apiUrl: string;
  model: string;
}

const SETTINGS_KEY = "ai-app-gen-settings";

// 默认设置
const DEFAULT_SETTINGS: AISettings = {
  apiKey: "",
  apiUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4o",
};

// 从 localStorage 加载设置
export function loadSettings(): AISettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
  return DEFAULT_SETTINGS;
}

// 保存设置到 localStorage
export function saveSettings(settings: AISettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

// 检查设置是否有效
export function isSettingsValid(settings: AISettings): boolean {
  return !!(settings.apiKey && settings.apiUrl && settings.model);
}

// 预设配置
export const AI_PRESETS: Record<string, Partial<AISettings>> = {
  openai: {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
  },
  "openai-3.5": {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-3.5-turbo",
  },
  deepseek: {
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
  },
  ollama: {
    apiUrl: "http://localhost:11434/v1/chat/completions",
    model: "codellama",
  },
};
