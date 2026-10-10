/**
 * Maps Mio's Salesforce Knowledge export (Knowledge__kav + Knowledge__DataCategorySelection) to the canonical Article.
 *
 * Adjust ONLY this file when the real export arrives with the actual API field names.
 * Everything else (chunking, embeddings, retrieval, prompts) is unaffected.
 *
 * What we know from the "Kvalitetsdokument" printouts (scripts/pdf_to_canonical.py handles those directly):
 *   metadata  Dokumentnr. (= ArticleNumber), Versjon, Dokumenttype (Rutiner | Prosess | Brukermanual |
 *             Stillingsbeskrivelse | Dokument), Dokumentansvarlig (HMS, Drift, Salg, HR Admin, ...),
 *             Selskap (Mio BPA, Mio omsorg, Mio gruppen — multi-select), Publisert, Neste revidering
 *   sections  Formål, Omfang/virkeområde, Definisjoner, Aktivitet/beskrivelse (or Beskrivelse),
 *             Hjemmel, Ansvar, Relaterte dokumenter
 * The API names below are guesses in that shape (Formaal__c etc.); replace with the real ones from
 * Setup → Object Manager → Knowledge → Fields, or `sf sobject describe --sobject Knowledge__kav`.
 */
export const salesforceFieldMapping = {
  /** Stable article id used as primary key. Prefer KnowledgeArticleId over the version Id. */
  id: "KnowledgeArticleId",
  articleNumber: "ArticleNumber",
  title: "Title",
  summary: "Summary",
  /** Rich-text fields concatenated (in this order) to form the body. Each becomes a "## <label>" section. */
  bodyFields: [
    { field: "Formaal__c", label: "Formål" },
    { field: "Omfang__c", label: "Omfang/virkeområde" },
    { field: "Definisjoner__c", label: "Definisjoner" },
    { field: "Aktivitet__c", label: "Aktivitet/beskrivelse" },
    { field: "Hjemmel__c", label: "Hjemmel" },
    { field: "Ansvar__c", label: "Ansvar" },
    { field: "Relaterte_dokumenter__c", label: "Relaterte dokumenter" },
  ],
  /**
   * Plain fields that become categories ("<label>/<value>"; multi-select picklists are split on ";").
   * Mirrors what pdf_to_canonical.py does with the printout metadata.
   */
  categoryFields: [
    { field: "Dokumenttype__c", label: "Dokumenttype" },
    { field: "Selskap__c", label: "Selskap" },
    { field: "Dokumentansvarlig__c", label: "Dokumentansvarlig" },
  ],
  /** Plain fields shown as a metadata line at the top of the body (so the model can answer "who owns this?"). */
  metadataFields: [
    { field: "Dokumenttype__c", label: "Dokumenttype" },
    { field: "Dokumentansvarlig__c", label: "Dokumentansvarlig" },
    { field: "Selskap__c", label: "Selskap" },
    { field: "Neste_revidering__c", label: "Neste revidering" },
  ],
  language: "Language",
  version: "VersionNumber",
  lastPublished: "LastPublishedDate",
  urlName: "UrlName",
  /** Only rows with this PublishStatus are ingested. */
  publishStatus: { field: "PublishStatus", value: "Online" },
  /** Base URL used to build sourceUrl: `${instanceUrl}/lightning/r/Knowledge__kav/${Id}/view` */
  instanceUrl: process.env.SF_INSTANCE_URL ?? "https://miofamilien.lightning.force.com",
  /**
   * Data categories (Salesforce's own category tree). The export can carry them either
   *  (a) as a column on the article row (e.g. "DataCategories" = "Group1:Cat1;Group2:Cat2"), or
   *  (b) as a separate Knowledge__DataCategorySelection export joined on ParentId.
   */
  categories: {
    inlineField: "DataCategories",
    inlineSeparator: ";",
    inlineGroupSeparator: ":",
    selectionParentField: "ParentId",
    selectionGroupField: "DataCategoryGroupName",
    selectionNameField: "DataCategoryName",
  },
} as const;
