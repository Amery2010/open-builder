import { Key, Globe2 } from "lucide-react";
import type { WebSearchSettings } from "../../../store/settings";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "../../../i18n";

interface WebSearchTabProps {
  form: WebSearchSettings;
  setForm: (v: WebSearchSettings) => void;
  apiType: string;
  runtime?: "api" | "localCli";
  localNativeSearchAvailable?: boolean;
}

export function WebSearchTab({
  form,
  setForm,
  apiType,
  runtime = "api",
  localNativeSearchAvailable = false,
}: WebSearchTabProps) {
  const t = useT();
  const showBuiltinSearch =
    runtime === "localCli"
      ? localNativeSearchAvailable
      : apiType !== "openai-compatible";
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="searchEngine">
          <Globe2 size={16} className="inline mr-1" />
          {t.settings.searchServices.web}
        </Label>
        <Select
          value={form.engine}
          onValueChange={(v) => setForm({ ...form, engine: v as any })}
        >
          <SelectTrigger id="searchEngine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">
              {t.settings.webSearch.disabled}
            </SelectItem>
            {showBuiltinSearch && (
              <SelectItem value="builtin">
                {t.settings.webSearch.builtin}
              </SelectItem>
            )}
            <SelectItem value="tavily">Tavily</SelectItem>
            <SelectItem value="firecrawl">Firecrawl</SelectItem>
            <SelectItem value="exa">Exa</SelectItem>
          </SelectContent>
        </Select>

        {form.engine === "builtin" ? (
          <p className="text-xs text-muted-foreground">
            {t.settings.webSearch.builtinDesc}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t.settings.webSearch.desc}
          </p>
        )}
      </div>

      {form.engine === "tavily" && (
        <div className="space-y-2">
          <Label htmlFor="tavilyApiKey">
            <Key size={16} className="inline mr-1" />
            Tavily API Key
          </Label>
          <Input
            id="tavilyApiKey"
            type="password"
            value={form.tavilyApiKey}
            onChange={(e) => setForm({ ...form, tavilyApiKey: e.target.value })}
            placeholder="tvly-..."
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.tavilyKey.hint}
          </p>
        </div>
      )}

      {form.engine === "firecrawl" && (
        <div className="space-y-2">
          <Label htmlFor="firecrawlApiKey">
            <Key size={16} className="inline mr-1" />
            Firecrawl API Key
          </Label>
          <Input
            id="firecrawlApiKey"
            type="password"
            value={form.firecrawlApiKey}
            onChange={(e) =>
              setForm({ ...form, firecrawlApiKey: e.target.value })
            }
            placeholder="fc-..."
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.firecrawlKey.hint}
          </p>
        </div>
      )}

      {form.engine === "exa" && (
        <div className="space-y-2">
          <Label htmlFor="exaApiKey">
            <Key size={16} className="inline mr-1" />
            Exa API Key
          </Label>
          <Input
            id="exaApiKey"
            type="password"
            value={form.exaApiKey}
            onChange={(e) => setForm({ ...form, exaApiKey: e.target.value })}
            placeholder="Exa API Key"
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.exaKey.hint}
          </p>
        </div>
      )}
    </>
  );
}
