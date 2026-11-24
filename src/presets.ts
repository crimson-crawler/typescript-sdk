/**
 * Default `include=[...]` presets for the Crimson Crawler enrichment endpoints.
 *
 * The API's `include` parameter controls which enrichment layers run on a
 * request. These constants encode the most common shapes so consumers do not
 * have to memorize them.
 */

/**
 * The API's default for `/enrich/cve`: every seeded or committed layer.
 *
 * Mirrors `v1_api.models.requests._TIER_A` so a caller who drills into the raw
 * endpoint gets the same answer. Pass `include` to narrow it.
 */
export const CVE_FULL_WALK = [
  "android_bulletin",
  "capec",
  "cellular",
  "certfr_advisories",
  "cisa_campaigns",
  "cisa_kev",
  "csaf_advisories",
  "cvss_bt",
  "cwe",
  "details",
  "detections",
  "emb3d",
  "epss",
  "exploits",
  "kev",
  "log_sources",
  "mitigations",
  "nist_controls",
  "ot_context",
  "poc",
  "sigma",
  "osv",
  "ssvc",
  "techniques",
  "tie",
  "weakness_ranks",
] as const;

/** Quick CVE artifact-enrichment — score, exploit probability, KEV status. No chain walk. */
export const CVE_FAST = ["details", "epss", "kev", "cisa_kev"] as const;

/** Full walk plus AI summary and adversary attribution. Use for report generation. */
export const CVE_NARRATIVE = [
  ...CVE_FULL_WALK,
  "summary",
  "groups",
  "campaigns",
] as const;

/** IOC → MISP → linked techniques → groups, plus knowledge base. */
export const IOC_FULL_WALK = [
  "cisa_campaigns",
  "defend",
  "detections",
  "galaxies",
  "listed_on",
  "log_sources",
  "misp_attributes",
  "mitigations",
  "network_context",
  "nist_controls",
  "sightings",
  "techniques",
  "tie",
  "warninglist",
] as const;

/** IOC lookup against MISP feeds only — no technique resolution. */
export const IOC_FAST = ["misp_attributes"] as const;

/** CWE → CAPEC → ATT&CK with TIE predictions. Use when starting from a weakness. */
export const CWE_FULL_WALK = ["capecs", "techniques", "tie"] as const;

/** Technique enrichment with TIE, adversary attribution, and Navigator JSON. */
export const TECHNIQUE_FULL = [
  "asset_classes",
  "atomic_red_team",
  "cisa_campaigns",
  "defend",
  "details",
  "detections",
  "fight",
  "framework_mappings",
  "fraud",
  "log_sources",
  "lolbas",
  "lotl",
  "mitigations",
  "nist_controls",
  "sigma",
  "tie",
] as const;

/** Product layers plus MISP and knowledge-base context; wrapper defaults to 2 CVEs per page. */
export const PRODUCT_FULL = [
  "android_bulletin",
  "capec",
  "cellular",
  "certfr_advisories",
  "cisa_campaigns",
  "cisa_kev",
  "csaf_advisories",
  "cvss_bt",
  "cwe",
  "defend",
  "details",
  "detections",
  "emb3d",
  "epss",
  "exploits",
  "kev",
  "log_sources",
  "mitigations",
  "nist_controls",
  "ot_context",
  "osv",
  "poc",
  "risk_summary",
  "sigma",
  "ssvc",
  "techniques",
  "tie",
  "misp",
  "knowledgebase",
  "weakness_ranks",
] as const;

/**
 * Full open-source-package walk: OSV.dev advisories (severity, affected/fixed ranges,
 * references) plus each aliased CVE enriched through the CWE → CAPEC → ATT&CK + EPSS/KEV
 * chain. The package-ecosystem analogue of {@link PRODUCT_FULL}.
 */
export const PACKAGE_FULL = [
  "details",
  "severity",
  "affected",
  "references",
  "epss",
  "kev",
  "cwe",
  "capec",
  "techniques",
  "tie",
] as const;

/**
 * ATLAS adversarial-ML technique walk: the technique plus its ATLAS parent/sub-technique
 * family. ATLAS carries no ATLAS-to-Enterprise edge, so there is no Enterprise-keyed layer
 * (predictions, adversary graph, Navigator JSON, CVEs, NIST controls) to walk.
 */
export const ATLAS_FULL = ["details", "techniques"] as const;

/**
 * Campaign walk: campaign profile, its techniques with TIE predictions, the groups and
 * tooling behind it, the CVEs it exploited, and Navigator JSON.
 */
export const CAMPAIGN_FULL = [
  "details",
  "techniques",
  "tie",
  "groups",
  "software",
  "cves",
  "navigator",
] as const;

/**
 * CAPEC attack-pattern walk: pattern details, mapped ATT&CK techniques with TIE
 * predictions, exploitable CVEs, and the adversary graph plus Navigator JSON.
 */
export const CAPEC_FULL = [
  "details",
  "techniques",
  "tie",
  "cves",
  "groups",
  "software",
  "campaigns",
  "navigator",
] as const;

/**
 * Concealment-technique (CLOAK) walk: the CLOAK object plus knowledge base context.
 * CLOAK objects carry no ATT&CK references at all, so there is no technique hop — no
 * `techniques`, no TIE predictions, and no adversary attribution.
 */
export const CLOAK_FULL = ["details", "knowledgebase"] as const;

/**
 * D3FEND defensive-technique walk: countermeasure details, the offensive techniques it
 * counters, plus knowledge base context.
 *
 * Shorter than the other `*_FULL` presets by design — D3FEND has no adversary-graph
 * layers, so knowledge base context is the only meaningful addition. The KB
 * revision history (`versions`) is opt-in on every endpoint, not part of any preset.
 */
export const DEFEND_FULL = ["details", "techniques", "knowledgebase"] as const;

/**
 * DISARM disinformation-technique walk: the technique and its DISARM parent/sub-technique family.
 * DISARM has no ATT&CK-Enterprise-keyed layer to walk — the corpus carries no
 * groups/software/campaigns/mitigations/detections/defend objects, and Navigator renders
 * enterprise/mobile/ICS ATT&CK layers only.
 */
export const DISARM_FULL = ["details", "techniques"] as const;

/**
 * Fraud-technique (MITRE F3) walk: the F3 object plus the ATT&CK Enterprise techniques its
 * 43 borrowed `T####` ids resolve to, with knowledge base context. F3 carries no
 * adversary graph or attribution layer, so the chain ends at the technique hop.
 */
export const F3_FULL = ["details", "techniques", "knowledgebase"] as const;

/**
 * Threat-actor walk: group profile, techniques and tooling with TIE predictions, its
 * campaigns and exploited CVEs, plus Navigator JSON.
 */
export const GROUP_FULL = [
  "details",
  "detections",
  "log_sources",
  "mitigations",
  "nist_controls",
  "techniques",
  "software",
  "tie",
  "campaigns",
  "cves",
  "navigator",
] as const;

/**
 * Regional profile walk: region details plus knowledge base context.
 */
export const LOCATION_FULL = ["details", "knowledgebase"] as const;

/**
 * Sector profile walk: sector details plus knowledge base context.
 */
export const SECTOR_FULL = ["details", "knowledgebase"] as const;

/**
 * Malware/tool walk: software details, the techniques it implements with TIE predictions,
 * the groups and campaigns using it, the CVEs it exploits, plus Navigator JSON.
 */
export const SOFTWARE_FULL = [
  "details",
  "techniques",
  "tie",
  "groups",
  "campaigns",
  "cves",
  "navigator",
] as const;
