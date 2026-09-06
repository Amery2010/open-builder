import type {
  AssetSearchSettings,
  AISettings,
  WebSearchSettings,
} from "../../../store/settings";
import { AssetSearchTab } from "./AssetSearchTab";
import { WebSearchTab } from "./WebSearchTab";

interface SearchServicesTabProps {
  webSearchForm: WebSearchSettings;
  setWebSearchForm: (value: WebSearchSettings) => void;
  assetSearchForm: AssetSearchSettings;
  setAssetSearchForm: (value: AssetSearchSettings) => void;
  apiType: string;
  runtime?: AISettings["runtime"];
  localNativeSearchAvailable?: boolean;
}

export function SearchServicesTab({
  webSearchForm,
  setWebSearchForm,
  assetSearchForm,
  setAssetSearchForm,
  apiType,
  runtime,
  localNativeSearchAvailable,
}: SearchServicesTabProps) {
  return (
    <>
      <section className="space-y-4" aria-labelledby="web-search-heading">
        <WebSearchTab
          form={webSearchForm}
          setForm={setWebSearchForm}
          apiType={apiType}
          runtime={runtime}
          localNativeSearchAvailable={localNativeSearchAvailable}
        />
      </section>

      <section className="space-y-4" aria-labelledby="asset-search-heading">
        <AssetSearchTab form={assetSearchForm} setForm={setAssetSearchForm} />
      </section>
    </>
  );
}
