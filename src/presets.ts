/**
 * Default `include=[...]` presets for the Crimson Crawler enrichment endpoints.
 *
 * The API's `include` parameter controls which enrichment layers run on a
 * request. These constants encode the most common shapes so consumers do not
 * have to memorize them.
 */

/**
 * Full CVE → CWE → CAPEC → ATT&CK → TIE chain plus MISP, knowledge base, and web context.
 *
 * This is the recon-agent default. Returns the complete enrichment surface in
 * one round trip. Latency is the highest of any preset (~5-30s on cold cache,
 * sub-second on warm cache).
 */
export const CVE_FULL_WALK = [
  "details",
  "epss",
  "kev",
  "cwe",
  "capec",
  "techniques",
  "tie",
  "misp",
  "knowledgebase",
  "web",
] as const;

/** Quick CVE artifact-enrichment — score, exploit probability, KEV status. No chain walk. */
export const CVE_FAST = ["details", "epss", "kev"] as const;

/** Full walk plus AI summary and adversary attribution. Use for report generation. */
export const CVE_NARRATIVE = [
  ...CVE_FULL_WALK,
  "summary",
  "groups",
  "campaigns",
] as const;

/** IOC → MISP → linked techniques → groups, plus knowledge base and web. */
export const IOC_FULL_WALK = [
  "misp_attributes",
  "techniques",
  "groups",
  "knowledgebase",
  "web",
] as const;

/** IOC lookup against MISP feeds only — no technique resolution. */
export const IOC_FAST = ["misp_attributes"] as const;

/** CWE → CAPEC → ATT&CK with TIE predictions. Use when starting from a weakness. */
export const CWE_FULL_WALK = ["capecs", "techniques", "tie"] as const;

/** Technique enrichment with TIE, adversary attribution, and Navigator JSON. */
export const TECHNIQUE_FULL = [
  "details",
  "tie",
  "groups",
  "software",
  "campaigns",
  "navigator",
] as const;

/**
 * Full product/version walk: matched CVEs with severity, exploit signals, weakness
 * mapping, ATT&CK techniques, threat predictions, MISP events, knowledge base, and web context.
 */
export const PRODUCT_FULL = [
  "details",
  "epss",
  "kev",
  "cwe",
  "capec",
  "techniques",
  "tie",
  "misp",
  "knowledgebase",
  "web",
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
 * ATLAS adversarial-ML technique walk: technique details, linked ATT&CK techniques,
 * TIE predictions, and the adversary graph (groups, software, campaigns) plus Navigator JSON.
 */
export const ATLAS_FULL = [
  "details",
  "techniques",
  "tie",
  "groups",
  "software",
  "campaigns",
  "navigator",
] as const;

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
 * D3FEND defensive-technique walk: countermeasure details, the offensive techniques it
 * counters, plus knowledge base and web context.
 *
 * Shorter than the other `*_FULL` presets by design — D3FEND has no adversary-graph
 * layers, so knowledge base and web context are the only meaningful additions.
 */
export const DEFEND_FULL = [
  "details",
  "techniques",
  "knowledgebase",
  "web",
] as const;

/**
 * DISARM disinformation-technique walk: technique details, its countermeasures, mapped
 * ATT&CK techniques with TIE predictions, and the adversary graph plus Navigator JSON.
 */
export const DISARM_FULL = [
  "details",
  "countermeasures",
  "techniques",
  "tie",
  "groups",
  "software",
  "campaigns",
  "navigator",
] as const;

/**
 * Threat-actor walk: group profile, techniques and tooling with TIE predictions, its
 * campaigns and exploited CVEs, targeted sectors and regions, plus Navigator JSON.
 */
export const GROUP_FULL = [
  "details",
  "techniques",
  "software",
  "tie",
  "campaigns",
  "cves",
  "sectors",
  "locations",
  "navigator",
] as const;

/**
 * Regional threat-landscape walk: region details, active groups and their techniques with
 * TIE predictions, tooling, campaigns, affected sectors, plus Navigator JSON.
 */
export const LOCATION_FULL = [
  "details",
  "groups",
  "techniques",
  "tie",
  "software",
  "campaigns",
  "sectors",
  "navigator",
] as const;

/**
 * Sector threat-landscape walk: sector details, the groups targeting it and their techniques
 * with TIE predictions, tooling, campaigns, affected regions, plus Navigator JSON.
 */
export const SECTOR_FULL = [
  "details",
  "groups",
  "techniques",
  "tie",
  "software",
  "campaigns",
  "locations",
  "navigator",
] as const;

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
