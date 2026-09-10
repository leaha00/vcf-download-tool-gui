const { runCli } = require('./cliRunner');
const { parseTable } = require('./tableParser');
const { TOKEN_FILE } = require('./config');

// --- CLI >= 9.1.1: `artifacts list` / `artifacts download` -----------------
//
// 9.1.1.0 added a top-level `artifacts` command for the OCI-based content the
// `binaries` command can't handle - vSphere Kubernetes Releases (VKR),
// vSphere Supervisor / Supervisor Service updates, VKS, the VCF CLI, VCF
// services, and Data Service Manager. It's gated on CLI version by the
// caller (routes.js), never reached on an older CLI.
//
// The list is narrowed by exactly one of:
//   --category=<CATEGORY>   one of the six high-level buckets below
//   --component=<COMPONENT>  a specific component enum (e.g. VKR)
// plus the mandatory --vcf-version and (optional) --sku. `--depot-store` is
// deliberately NOT passed for `list` - it's not in the list subcommand's
// usage synopsis and we don't want listing to depend on the depot path.

// The six --category values the CLI accepts (from `artifacts list --help`).
// `label` is what the Type dropdown shows; the GUI also offers VKR, which is
// a --component rather than a --category (see ARTIFACT_COMPONENTS).
const ARTIFACT_CATEGORIES = [
  { key: 'SUPERVISOR', label: 'vSphere Supervisor' },
  { key: 'VKS', label: 'vSphere Kubernetes Service (VKS)' },
  { key: 'SUPERVISOR_SERVICE', label: 'Supervisor Services' },
  { key: 'VCF_CLI', label: 'VCF CLI & plugins' },
  { key: 'VCF_SERVICE', label: 'VCF Services' },
  { key: 'DSM', label: 'Data Service Manager (DSM)' },
];

// --component values surfaced directly in the dropdown. VKR is the headline
// 9.1.1 use case ("choose exactly which vSphere Kubernetes Releases to
// download") and isn't reachable via any --category.
const ARTIFACT_COMPONENTS = [
  { key: 'VKR', label: 'vSphere Kubernetes Releases (VKR)' },
];

const CATEGORY_KEYS = new Set(ARTIFACT_CATEGORIES.map((c) => c.key));
const COMPONENT_KEYS = new Set(ARTIFACT_COMPONENTS.map((c) => c.key));

function validateFilter({ category, component }) {
  if (category && component) {
    throw new Error('Specify either an artifact category or a component, not both');
  }
  if (category && !CATEGORY_KEYS.has(category)) {
    throw new Error(`Unknown artifact category: ${category}`);
  }
  if (component && !COMPONENT_KEYS.has(component)) {
    throw new Error(`Unknown artifact component: ${component}`);
  }
  if (!category && !component) {
    throw new Error('An artifact category or component is required');
  }
}

// The CLI prints the same style of pipe table as `binaries list`, but the
// exact column headers for `artifacts list` aren't documented (the help only
// promises "component name, version number, size and type"). Normalise
// whatever comes back into the same row shape the binaries table/front-end
// already render, so nothing downstream needs to know which command produced
// the row. Anything without a version is dropped - it can't be downloaded or
// displayed usefully.
function normalizeRow(r) {
  const component =
    r.component || r.component_name || r.name || r.artifact || r.bundle || '';
  const version =
    r.version || r.component_version || r.artifact_version || r.bundle_version || '';
  if (!version) return null;

  const fullName =
    r.component_full_name || r.full_name || r.description || r.display_name || component;
  const type = r.image_type || r.type || r.artifact_type || r.category || r.kind || '';
  const releaseDate = r.release_date || r.released_date || r.release || r.date || '';
  const size = r.size || r.download_size || r.artifact_size || '';
  const id = r.id || r.bundle_id || r.artifact_id || `artifact:${component}:${version}`;

  return {
    id,
    component,
    component_full_name: fullName,
    version,
    type,
    release_date: releaseDate,
    size,
    // downloaded / partial are filled in by the /artifacts route via
    // lib/artifactsIndex (the `component` above is the enum it keys on).
    downloaded: false,
    partial: false,
    isArtifact: true,
  };
}

async function listArtifacts({ version, sku = 'VCF', category, component }) {
  if (!version) throw new Error('version is required');
  validateFilter({ category, component });

  const args = [
    'artifacts',
    'list',
    `--depot-download-activation-code-file=${TOKEN_FILE}`,
    `--vcf-version=${version}`,
    `--sku=${sku}`,
  ];
  if (category) args.push(`--category=${category}`);
  if (component) args.push(`--component=${component}`);

  const { stdout } = await runCli(args);
  const artifacts = parseTable(stdout)
    .map(normalizeRow)
    .filter(Boolean);

  // De-dupe on id the same way binaries.js does across its INSTALL/UPGRADE
  // queries - a component can legitimately show up more than once.
  const byId = new Map();
  for (const a of artifacts) byId.set(a.id, a);

  return { artifacts: [...byId.values()], queriedVersion: version };
}

module.exports = {
  listArtifacts,
  validateFilter,
  ARTIFACT_CATEGORIES,
  ARTIFACT_COMPONENTS,
  CATEGORY_KEYS,
  COMPONENT_KEYS,
};
