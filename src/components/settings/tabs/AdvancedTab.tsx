import { useEffect, useState } from "react";
import {
  Braces,
  ScanSearch,
  Shield,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import type { SystemSettings } from "../../../store/settings";
import {
  clearProxyLog,
  getProxyLog,
  isTauri,
  type ProxyLogEntry,
} from "../../../lib/infra/proxy";
import { getMcpPlatformCapabilities } from "../../../lib/mcp/tauri-host";
import { Button } from "@/components/ui/button";
import { CapsuleGroup } from "@/components/ui/capsule-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../../../i18n";

interface FullPermissionsLabels {
  label: string;
  on: string;
  off: string;
  hint: string;
  stopFirst: string;
}

export interface AdvancedTabProps {
  form: SystemSettings;
  setForm: (value: SystemSettings) => void;
  customSystemPromptError?: string;
  runtimeChangeLocked?: boolean;
  fullPermissionsLabels?: Partial<FullPermissionsLabels>;
}

const CUSTOM_SYSTEM_PROMPT_ID = "custom-system-prompt";
const FULL_PERMISSIONS_HINT_ID = "full-permissions-hint";
const DEFAULT_FULL_PERMISSIONS_LABELS: FullPermissionsLabels = {
  label: "Full permissions",
  on: "Enabled",
  off: "Disabled",
  hint: "Allow destructive project file operations without a permission prompt. Other safety checks still apply.",
  stopFirst: "Stop the current task before changing full permissions.",
};

export function AdvancedTab({
  form,
  setForm,
  customSystemPromptError,
  runtimeChangeLocked = false,
  fullPermissionsLabels,
}: AdvancedTabProps) {
  const t = useT();
  const permissionsLabels = {
    ...DEFAULT_FULL_PERMISSIONS_LABELS,
    ...fullPermissionsLabels,
  };
  const fullPermissionsHint = runtimeChangeLocked
    ? permissionsLabels.stopFirst
    : permissionsLabels.hint;
  const [proxyLog, setProxyLog] = useState<ProxyLogEntry[]>(() =>
    getProxyLog(),
  );
  const [supportsSkillScripts, setSupportsSkillScripts] = useState(false);

  useEffect(() => {
    let active = true;
    void getMcpPlatformCapabilities().then((capabilities) => {
      if (active) setSupportsSkillScripts(capabilities.skillScripts);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={CUSTOM_SYSTEM_PROMPT_ID}>
          <Braces size={16} className="inline mr-1" />
          {t.settings.customSystemPrompt.label}
        </Label>
        <Textarea
          id={CUSTOM_SYSTEM_PROMPT_ID}
          value={form.customSystemPrompt}
          rows={3}
          className="field-sizing-fixed min-h-0 resize-none font-mono text-xs leading-relaxed focus-visible:border-input"
          placeholder={t.settings.customSystemPrompt.placeholder}
          aria-invalid={customSystemPromptError ? "true" : undefined}
          aria-describedby={
            customSystemPromptError
              ? `${CUSTOM_SYSTEM_PROMPT_ID}-error`
              : undefined
          }
          onChange={(event) =>
            setForm({ ...form, customSystemPrompt: event.target.value })
          }
        />
        {customSystemPromptError && (
          <p
            id={`${CUSTOM_SYSTEM_PROMPT_ID}-error`}
            className="text-xs text-destructive"
            role="alert"
          >
            {customSystemPromptError}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>
          <ScanSearch size={16} className="inline mr-1" />
          {t.settings.autoQa.label}
        </Label>
        <CapsuleGroup
          label={t.settings.autoQa.label}
          value={form.autoQaEnabled ? "on" : "off"}
          onChange={(value) =>
            setForm({ ...form, autoQaEnabled: value === "on" })
          }
          options={[
            { value: "on", label: t.settings.autoQa.on },
            { value: "off", label: t.settings.autoQa.off },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {t.settings.autoQa.hint}
        </p>
      </div>

      {supportsSkillScripts && (
        <div className="space-y-2">
          <Label>
            <TerminalSquare size={16} className="inline mr-1" />
            {t.settings.skillScripts.label}
          </Label>
          <CapsuleGroup
            label={t.settings.skillScripts.label}
            value={form.developerSkillScriptsEnabled ? "on" : "off"}
            onChange={(value) =>
              setForm({
                ...form,
                developerSkillScriptsEnabled: value === "on",
              })
            }
            options={[
              { value: "on", label: t.settings.skillScripts.on },
              { value: "off", label: t.settings.skillScripts.off },
            ]}
          />
          <p className="text-xs text-destructive">
            {t.settings.skillScripts.hint}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>
          <ShieldAlert size={16} className="inline mr-1" />
          {permissionsLabels.label}
        </Label>
        <CapsuleGroup
          label={
            runtimeChangeLocked
              ? `${permissionsLabels.label}. ${permissionsLabels.stopFirst}`
              : permissionsLabels.label
          }
          value={form.permissionBrokerBypassEnabled ? "on" : "off"}
          onChange={(value) =>
            setForm({
              ...form,
              permissionBrokerBypassEnabled: value === "on",
            })
          }
          disabled={runtimeChangeLocked}
          options={[
            { value: "on", label: permissionsLabels.on },
            { value: "off", label: permissionsLabels.off },
          ]}
        />
        <p
          id={FULL_PERMISSIONS_HINT_ID}
          className="text-xs text-muted-foreground"
          role="note"
        >
          {fullPermissionsHint}
        </p>
      </div>

      {isTauri() && (
        <div className="space-y-2">
          <Label>
            <Shield size={16} className="inline mr-1" />
            {t.settings.reverseProxy.label}
          </Label>
          <CapsuleGroup
            label={t.settings.reverseProxy.label}
            value={form.reverseProxy ? "on" : "off"}
            onChange={(v) => {
              const enabled = v === "on";
              setForm({ ...form, reverseProxy: enabled });
            }}
            options={[
              { value: "on", label: t.settings.reverseProxy.on },
              { value: "off", label: t.settings.reverseProxy.off },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.reverseProxy.hint}
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t.settings.reverseProxy.allowedHosts}
            </Label>
            <Input
              value={form.reverseProxyAllowedHosts}
              onChange={(e) => {
                const value = e.target.value;
                setForm({ ...form, reverseProxyAllowedHosts: value });
              }}
              placeholder="https://api.openai.com, http://localhost:11434"
              className="h-8 text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.reverseProxy.allowedHostsHint}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {t.settings.reverseProxy.recentRequests}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setProxyLog(getProxyLog())}
                >
                  {t.settings.reverseProxy.refreshLog}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    clearProxyLog();
                    setProxyLog([]);
                  }}
                >
                  {t.settings.reverseProxy.clearLog}
                </Button>
              </div>
            </div>
            {proxyLog.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t.settings.reverseProxy.emptyLog}
              </p>
            ) : (
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {proxyLog
                  .slice(-5)
                  .reverse()
                  .map((entry) => (
                    <div
                      key={`${entry.timestamp}-${entry.kind}-${entry.host}-${entry.path}`}
                      className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]"
                    >
                      <span className="font-mono text-muted-foreground">
                        {entry.method}
                      </span>
                      <span
                        className="truncate"
                        title={`${entry.host}${entry.path}`}
                      >
                        {entry.host}
                        {entry.path}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {entry.kind}
                      </span>
                      <span className="text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
