import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, FileCheck2 } from "lucide-react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { ConfigSaveError, SettingsCard, SettingsToggle } from "../../shared/view";
import { FormRow, NumberInput, Select } from "../../shared/components/Inputs";
import { safeParseYaml, configToYamlString } from "../modelPool/utils/configYaml";
import { patch } from "../modelPool/utils/patch";
import type { PilotDeckConfig } from "../modelPool/types";

export function ReviewerSettings({ config, onChange }: { config: PilotDeckConfig; onChange: (config: PilotDeckConfig) => void }) {
  const { t } = useTranslation("settings");
  const review = config.agent?.acceptanceReview;
  const enabled = review?.enabled !== false;
  const memoryEnabled = config.memory?.enabled === true;
  const modelOptions = [{ value: "", label: t("acceptanceReview.inherit") }, ...Object.entries(config.model?.providers ?? {}).flatMap(([provider, definition]) =>
    Object.keys(definition.models ?? {}).map(model => ({ value: `${provider}/${model}`, label: `${provider} / ${model}` })))];
  if (review?.model && !modelOptions.some(option => option.value === review.model)) modelOptions.push({ value: review.model, label: `${review.model} (${t("acceptanceReview.unavailable")})` });
  const update = (key: string, value: unknown) => onChange(patch(config, ["agent", "acceptanceReview", key], value));
  return <div className="space-y-5">
    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t("acceptanceReview.description")}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <SettingsCard className="p-5">
        <div className="mb-3 flex items-center justify-between"><FileCheck2 className="h-5 w-5 text-primary" /><span className="text-xs text-muted-foreground">01</span></div>
        <h3 className="mb-1 text-sm font-semibold">{t("acceptanceReview.rulesTitle")}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{t("acceptanceReview.rulesDescription")}</p>
      </SettingsCard>
      <SettingsCard className="border-primary/30 bg-primary/5 p-5">
        <div className="mb-3 flex items-center justify-between"><ClipboardCheck className="h-5 w-5 text-primary" /><span className="text-xs text-muted-foreground">02</span></div>
        <h3 className="mb-1 text-sm font-semibold">{t("acceptanceReview.modelTitle")}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{t("acceptanceReview.modelDescription")}</p>
      </SettingsCard>
    </div>
    <SettingsCard divided>
      <FormRow label={t("acceptanceReview.enabled")} description={t("acceptanceReview.enabledHelp")}>
        <SettingsToggle checked={enabled} ariaLabel={t("acceptanceReview.enabled")} onChange={value => update("enabled", value)} />
      </FormRow>
      {enabled && <>
        <FormRow label={t("acceptanceReview.model")} description={review?.model ? t("acceptanceReview.customHelp") : t("acceptanceReview.inheritHelp")}>
          <Select value={review?.model ?? ""} options={modelOptions} onChange={value => update("model", value || undefined)} />
        </FormRow>
        <FormRow label={t("acceptanceReview.turns")} description={t("acceptanceReview.turnsHelp")}>
          <NumberInput value={review?.maxTurns ?? 4} min={1} max={8} onChange={value => { if (value === undefined || (Number.isInteger(value) && value >= 1 && value <= 8)) update("maxTurns", value); }} />
        </FormRow>
        <FormRow label={t("acceptanceReview.timeout")} description={t("acceptanceReview.timeoutHelp")}>
          <NumberInput value={(review?.timeoutMs ?? 60000) / 1000} min={1} max={180} onChange={value => { if (value === undefined || (Number.isInteger(value) && value >= 1 && value <= 180)) update("timeoutMs", value === undefined ? undefined : value * 1000); }} />
        </FormRow>
      </>}
    </SettingsCard>
    <SettingsCard>
      <FormRow label={t("acceptanceReview.memoryCapture")} description={t(memoryEnabled ? "acceptanceReview.memoryCaptureHelp" : "acceptanceReview.memoryDisabledHelp")}>
        <SettingsToggle checked={memoryEnabled && config.memory?.captureAcceptance !== false} disabled={!memoryEnabled}
          ariaLabel={t("acceptanceReview.memoryCapture")}
          onChange={value => onChange(patch(config, ["memory", "captureAcceptance"], value))} />
      </FormRow>
    </SettingsCard>
    <p className="text-xs leading-5 text-muted-foreground">{t(enabled ? "acceptanceReview.evidenceHelp" : "acceptanceReview.disabledHelp")}</p>
  </div>;
}

export default function AgentReviewSections({ title }: { title: string }) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const config = useMemo(() => safeParseYaml(raw), [raw]);
  return <div className="space-y-6">
    <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
    <ConfigSaveError error={error} />
    {loading ? <p>{t("pilotDeckConfig.loading")}</p> : !config ? <p className="text-destructive">{t("acceptanceReview.invalidConfig")}</p> :
      <ReviewerSettings config={config} onChange={next => { void commitRaw(configToYamlString(next)); }} />}
  </div>;
}
