/** Registry codes are provider-independent; API codes stay in provider settings. */
const DIALECT_NAMES: Record<string, [string, string]> = {
  ff: ["富拉语", "Fulah"],
  yue: ["粤语", "Cantonese"],
  wuu: ["吴语", "Wu Chinese"],
  nan: ["闽南语", "Min Nan Chinese"],
  hak: ["客家话", "Hakka Chinese"],
  gan: ["赣语", "Gan Chinese"],
  hsn: ["湘语", "Xiang Chinese"],
  cjy: ["晋语", "Jin Chinese"],
  kea: ["佛得角克里奥尔语", "Kabuverdianu"],
  luo: ["卢奥语", "Luo"],
  nso: ["北索托语", "Northern Sotho"],
  umb: ["翁本杜语", "Umbundu"],
};

export function languageName(code: string, locale: string): string {
  const dialect = DIALECT_NAMES[code];
  if (dialect) return dialect[locale.startsWith("zh") ? 0 : 1];
  return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
}

export const DOUBAO_LANGUAGE_CODES: Record<string, string> = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  id: "id-ID",
  es: "es-MX",
  pt: "pt-BR",
  de: "de-DE",
  fr: "fr-FR",
  ko: "ko-KR",
  fil: "fil-PH",
  ms: "ms-MY",
  th: "th-TH",
  ar: "ar-SA",
  it: "it-IT",
  bn: "bn-BD",
  el: "el-GR",
  nl: "nl-NL",
  ru: "ru-RU",
  tr: "tr-TR",
  vi: "vi-VN",
  pl: "pl-PL",
  ro: "ro-RO",
  ne: "ne-NP",
  uk: "uk-UA",
  yue: "yue-CN",
};
