// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2023-2026 MOSSDeF, Stan Grishin (stangri@melmac.ca).
//
// MoCI add-on for adblock-fast. The MoCI equivalent of luci-app-adblock-fast:
// it talks to the moci.adblock-fast rpcd ucode backend shipped by this package
// (a renamed copy of the luci.adblock-fast backend) which in turn drives the
// adblock-fast service. Pure vanilla-JS module loaded into the MoCI SPA.

const OBJ = 'moci.adblock-fast';
const PKG = 'adblock-fast';
const URL = 'https://docs.mossdef.org/adblock-fast/';
const APP_COMPAT = 17; // mirrors luci-app-adblock-fast's LuciCompat handshake

// Human-readable text for the status codes the backend reports.
const STATUS_TABLE = {
	statusNoInstall: `${PKG} is not installed or not found`,
	statusStopped: 'Stopped',
	statusStarting: 'Starting',
	statusProcessing: 'Processing lists',
	statusRestarting: 'Restarting',
	statusForceReloading: 'Force Reloading',
	statusDownloading: 'Downloading lists',
	statusFail: 'Failed to start',
	statusSuccess: 'Active',
	statusTriggerBootWait: 'Waiting for trigger (on_boot)',
	statusTriggerStartWait: 'Waiting for trigger (on_start)'
};

const WARNING_TABLE = {
	warningInternalVersionMismatch:
		'Internal version mismatch (package: %s, app: %s, rpcd: %s), you may need to update packages or reboot the device.',
	warningExternalDnsmasqConfig: "Use of external dnsmasq config file detected, please set 'dns' option to 'dnsmasq.conf'",
	warningMissingRecommendedPackages: "Missing recommended package: '%s'",
	warningInvalidCompressedCacheDir: "Invalid compressed cache directory '%s'",
	warningFreeRamCheckFail: "Can't detect free RAM",
	warningSanityCheckTLD: 'Sanity check discovered TLDs in %s',
	warningSanityCheckLeadingDot: 'Sanity check discovered leading dots in %s',
	warningInvalidDomainsRemoved: 'Removed %s invalid domain entries from block-list',
	warningCronDisabled: 'Cron service is not enabled or running. Enable it with: %s.',
	warningCronMissing: 'Cron daemon is not available. Enable BusyBox crond with: %s; otherwise install a cron daemon.',
	warningParallelDownloadsThrottled: 'Parallel downloads reduced to %s due to low free memory',
	warningDownloadTimeout: "Download of '%s' timed out; the server may be too slow"
};

const ERROR_TABLE = {
	errorConfigValidationFail: `Config (/etc/config/${PKG}) validation failure!`,
	errorServiceDisabled: `${PKG} is currently disabled`,
	errorNoDnsmasqIpset: 'The dnsmasq ipset support is enabled, but dnsmasq is not installed or lacks ipset support',
	errorNoIpset: "The dnsmasq ipset support is enabled, but ipset is missing or lacks 'hash:net' support",
	errorNoDnsmasqNftset: 'The dnsmasq nft set support is enabled, but dnsmasq is not installed or lacks nft set support',
	errorNoNft: 'The dnsmasq nft sets support is enabled, but nft is not installed',
	errorNoWanGateway: `The ${PKG} failed to discover WAN gateway`,
	errorOutputDirCreate: 'Failed to create directory for %s file',
	errorOutputFileCreate: "Failed to create '%s' file",
	errorFailDNSReload: 'Failed to restart/reload DNS resolver',
	errorSharedMemory: 'Failed to access shared memory',
	errorSorting: 'Failed to sort data file',
	errorOptimization: 'Failed to optimize data file',
	errorAllowListProcessing: 'Failed to process allow-list',
	errorDataFileFormatting: 'Failed to format data file',
	errorMovingDataFile: "Failed to move temporary data file to '%s'",
	errorCreatingCompressedCache: 'Failed to create compressed cache',
	errorRemovingTempFiles: 'Failed to remove temporary files',
	errorRestoreCompressedCache: 'Failed to unpack compressed cache',
	errorRestoreCache: "Failed to move '%s' to '%s'",
	errorOhSnap: 'Failed to create block-list or restart DNS resolver',
	errorStopping: `Failed to stop ${PKG}`,
	errorDNSReload: 'Failed to reload/restart DNS resolver',
	errorDownloadingConfigUpdate: 'Failed to download Config Update file',
	errorDownloadingList: 'Failed to download %s',
	errorParsingConfigUpdate: 'Failed to parse Config Update file',
	errorParsingList: 'Failed to parse %s',
	errorNoSSLSupport: 'No HTTPS/SSL support on device',
	errorCreatingDirectory: 'Failed to create output/cache/gzip file directory',
	errorDetectingFileType: 'Failed to detect format for %s',
	errorNothingToDo: 'No blocked list URLs nor blocked-domains enabled',
	errorTooLittleRam: 'Free ram (%s) is not enough to process all enabled block-lists',
	errorCreatingBackupFile: 'failed to create backup file %s',
	errorDeletingDataFile: 'failed to delete data file %s',
	errorRestoringBackupFile: 'failed to restore backup file %s',
	errorNoOutputFile: 'failed to create final block-list %s',
	errorNoHeartbeat: 'Heartbeat domain is not accessible after resolver restart'
};

// Status codes that mean a long-running operation has settled.
const SETTLED = new Set(['statusSuccess', 'statusFail', 'statusStopped']);

function fmtMessage(template, info) {
	if (!template) return 'Unknown message';
	if (Array.isArray(info)) {
		let i = 0;
		return template.replace(/%s/g, () => (info[i++] ?? ''));
	}
	return template.replace(/%s/g, info ?? ' ');
}

function humanFileSize(bytes) {
	if (!bytes || bytes <= 0) return '';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function fmtPause(seconds) {
	const s = parseInt(seconds) || 20;
	if (s < 60) return s + 's';
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem === 0 ? m + 'm' : m + 'm ' + rem + 's';
}

// Parse a crontab entry into the discrete auto_update_* schedule fields.
// Ported verbatim (in spirit) from luci-app-adblock-fast's overview.js so the
// schedule round-trips identically through the shared backend.
function parseCronEntry(cronEntry) {
	const defaults = {
		auto_update_enabled: '0',
		auto_update_mode: 'daily',
		auto_update_hour: '4',
		auto_update_minute: '0',
		auto_update_weekday: '0',
		auto_update_monthday: '1',
		auto_update_every_ndays: '3',
		auto_update_every_nhours: '6'
	};
	if (!cronEntry || cronEntry.trim() === '') return defaults;

	const commented = cronEntry.trim().startsWith('#');
	const parts = cronEntry.replace(/^#\s*/, '').trim().split(/\s+/);
	if (parts.length < 6) return defaults;

	const [minute, hour, dom, month, dow] = parts;
	const isNumber = v => /^[0-9]+$/.test(v);
	const isStep = v => /^\*\/[0-9]+$/.test(v);

	if (month !== '*' || !isNumber(minute)) return defaults;

	const config = { ...defaults, auto_update_enabled: commented ? '0' : '1', auto_update_minute: minute };

	if (isStep(hour)) {
		if (dom !== '*' || dow !== '*') return defaults;
		config.auto_update_mode = 'every_n_hours';
		config.auto_update_every_nhours = hour.split('/')[1];
		return config;
	}
	if (!isNumber(hour)) return defaults;
	if (isStep(dom)) {
		if (dow !== '*') return defaults;
		config.auto_update_mode = 'every_n_days';
		config.auto_update_hour = hour;
		config.auto_update_every_ndays = dom.split('/')[1];
		return config;
	}
	if (dom !== '*') {
		if (!isNumber(dom) || dow !== '*') return defaults;
		config.auto_update_mode = 'monthly';
		config.auto_update_hour = hour;
		config.auto_update_monthday = dom;
		return config;
	}
	if (dow !== '*') {
		if (!isNumber(dow)) return defaults;
		config.auto_update_mode = 'weekly';
		config.auto_update_hour = hour;
		config.auto_update_weekday = dow;
		return config;
	}
	config.auto_update_mode = 'daily';
	config.auto_update_hour = hour;
	return config;
}

export default class AdBlockFastAddon {
	constructor(core) {
		this.core = core;
		this.page = null;
		this.statusTimer = null;
		this.logTimer = null;
		this.activeTab = 'tab_basic';
		this.core.registerRoute('/adblock-fast', () => this.render());
	}

	// ── backend plumbing ────────────────────────────────────────────────

	// Call a method on the moci.adblock-fast ubus object. Throws (with
	// .ubusStatus set) on a non-zero ubus status so render() can show the
	// "backend not available" safeguard instead of a broken page.
	async rpc(method, params = {}) {
		const res = await this.core.ubusCall(OBJ, method, { name: PKG, ...params }, { timeout: 30000 });
		if (!Array.isArray(res)) throw new Error(`${OBJ}.${method}: malformed response`);
		if (res[0] !== 0) {
			const err = new Error(`${OBJ}.${method}: ubus status ${res[0]}`);
			err.ubusStatus = res[0];
			throw err;
		}
		return res[1] || {};
	}

	async uciValues(config) {
		try {
			const res = await this.core.uciGet(config);
			return Array.isArray(res) && res[0] === 0 && res[1]?.values ? res[1].values : null;
		} catch {
			return null;
		}
	}

	// ── lifecycle ───────────────────────────────────────────────────────

	cleanup() {
		this.stopTimers();
		this.page = null;
	}

	stopTimers() {
		if (this.statusTimer) clearInterval(this.statusTimer);
		if (this.logTimer) clearInterval(this.logTimer);
		this.statusTimer = this.logTimer = null;
	}

	visible() {
		return this.page && !this.page.classList.contains('hidden');
	}

	async render() {
		this.page = document.getElementById('addon-adblock-fast-page');
		if (!this.page) return;
		this.stopTimers();
		this.page.innerHTML = `<div class="page-header"><h1>ADBLOCK-FAST</h1></div>
			<div class="adbf-loading">Loading…</div>`;

		// The single getInitStatus carries everything the page needs up front:
		// service state, platform support and per-URL file sizes. If the
		// moci.adblock-fast object is missing (force-removed dependency, rpcd
		// not reloaded), show an actionable safeguard rather than a broken page.
		let init;
		try {
			init = await this.rpc('getInitStatus');
		} catch (err) {
			return this.renderBackendMissing(err);
		}

		const [cron, qlog, cfg, dhcp, smartdns] = await Promise.all([
			this.rpc('getCronStatus').catch(() => ({})),
			this.rpc('getQueryLogStatus').catch(() => ({})),
			this.uciValues(PKG),
			this.uciValues('dhcp'),
			this.uciValues('smartdns')
		]);

		this.state = {
			init: init[PKG] || {},
			cron: cron[PKG] || {},
			qlog: qlog[PKG] || {},
			cfg: cfg || {},
			config: (cfg && cfg.config) || {},
			dhcp,
			smartdns
		};
		this.state.platform = this.state.init.platform || {};
		this.state.sizes = this.state.init.file_url || [];

		this.buildPage();
	}

	renderBackendMissing(err) {
		const denied = err && err.ubusStatus === 6;
		this.page.innerHTML = `
			<div class="page-header"><h1>ADBLOCK-FAST</h1></div>
			<div class="stat-card adbf-missing">
				<h2>Backend not available</h2>
				<p>The <code>${OBJ}</code> control backend did not respond${denied ? ' (access denied)' : ''}.</p>
				<p>This add-on ships that backend and depends on the <code>${PKG}</code> service and
				<code>rpcd-mod-ucode</code>. If a dependency was force-removed, reinstall this add-on.
				Otherwise reload rpcd:</p>
				<pre class="adbf-cmd">/etc/init.d/rpcd reload</pre>
				<p>Then reload this page. See the
				<a href="${URL}" target="_blank" rel="noopener">README</a> for details.</p>
			</div>`;
	}

	// ── page assembly ───────────────────────────────────────────────────

	buildPage() {
		const s = this.state;
		const enabled = !!s.init.enabled;

		let html = `<div class="page-header"><h1>ADBLOCK-FAST</h1></div>`;
		html += `<div class="stat-card" id="adbf-status"></div>`;

		if (!enabled) {
			html += `<div class="stat-card"><h2>Configuration</h2>
				<p class="adbf-muted">Service is disabled. Enable it using the Service Control buttons above to configure options.</p></div>`;
			this.page.innerHTML = html;
			this.renderStatus();
			this.startStatusPolling();
			return;
		}

		html += this.tabsMarkup();
		html += this.urlModalMarkup();
		this.page.innerHTML = html;

		this.renderStatus();
		this.fillConfigForm();
		this.renderUrlTable();
		this.attachHandlers();
		this.startStatusPolling();
	}

	tabsMarkup() {
		return `
		<div class="tabs" id="adbf-tabs">
			<button class="tab-btn active" data-tab="tab_basic">BASIC</button>
			<button class="tab-btn" data-tab="tab_advanced">ADVANCED</button>
			<button class="tab-btn" data-tab="tab_lists">LISTS</button>
			<button class="tab-btn" data-tab="tab_schedule">SCHEDULE</button>
			<button class="tab-btn" data-tab="tab_log">QUERY LOG</button>
		</div>
		<div class="tab-content" id="tab_basic">${this.basicMarkup()}</div>
		<div class="tab-content hidden" id="tab_advanced">${this.advancedMarkup()}</div>
		<div class="tab-content hidden" id="tab_lists">${this.listsMarkup()}</div>
		<div class="tab-content hidden" id="tab_schedule">${this.scheduleMarkup()}</div>
		<div class="tab-content hidden" id="tab_log">${this.logMarkup()}</div>`;
	}

	// Helpers that emit MoCI-styled form rows. id is always adbf-opt-<name>.
	row(name, label, control, descr) {
		return `<div class="form-group" id="adbf-row-${name}">
			<label class="form-label" for="adbf-opt-${name}">${label}</label>
			${control}
			${descr ? `<div class="adbf-descr">${descr}</div>` : ''}
		</div>`;
	}

	selectCtl(name, options) {
		const opts = options.map(o => `<option value="${this.core.escapeHtml(o[0])}">${this.core.escapeHtml(o[1])}</option>`).join('');
		return `<select class="form-input" id="adbf-opt-${name}">${opts}</select>`;
	}

	inputCtl(name, placeholder = '') {
		return `<input type="text" class="form-input" id="adbf-opt-${name}" placeholder="${this.core.escapeHtml(placeholder)}" />`;
	}

	rangeOptions(lo, hi, pad) {
		const out = [];
		for (let i = lo; i <= hi; i++) out.push([String(i), pad && i < 10 ? '0' + i : String(i)]);
		return out;
	}

	basicMarkup() {
		const p = this.state.platform;
		const dnsOpts = [];
		if (p.dnsmasq_installed) {
			dnsOpts.push(['dnsmasq.addnhosts', 'dnsmasq additional hosts']);
			dnsOpts.push(['dnsmasq.conf', 'dnsmasq config']);
			if (p.dnsmasq_ipset_support) dnsOpts.push(['dnsmasq.ipset', 'dnsmasq ipset']);
			if (p.dnsmasq_nftset_support) dnsOpts.push(['dnsmasq.nftset', 'dnsmasq nft set']);
			dnsOpts.push(['dnsmasq.servers', 'dnsmasq servers file']);
		}
		if (p.smartdns_installed) {
			dnsOpts.push(['smartdns.domainset', 'smartdns domain set']);
			if (p.smartdns_ipset_support) dnsOpts.push(['smartdns.ipset', 'smartdns ipset']);
			if (p.smartdns_nftset_support) dnsOpts.push(['smartdns.nftset', 'smartdns nft set']);
		}
		if (p.unbound_installed) dnsOpts.push(['unbound.adb_list', 'unbound adblock list']);
		if (!dnsOpts.length) dnsOpts.push(['dnsmasq.servers', 'dnsmasq servers file']);

		let html = `<div class="stat-card">`;
		html += this.row('dns', 'DNS Service', this.selectCtl('dns', dnsOpts),
			`DNS resolution option, see the <a href="${URL}#dns-resolver-option" target="_blank" rel="noopener">README</a> for details.`);
		html += this.row('dnsmasq_config_file_url', 'Dnsmasq Config File URL', this.inputCtl('dnsmasq_config_file_url'),
			'URL to the external dnsmasq config file.');

		// Instance selection (dnsmasq / smartdns) — shown only where applicable.
		if (p.dnsmasq_installed && this.state.dhcp) {
			html += this.row('dnsmasq_instance_option', 'Ad-blocking on dnsmasq instance(s)',
				this.selectCtl('dnsmasq_instance_option', [['*', 'All instances'], ['+', 'Select instances'], ['-', 'No ad-blocking on dnsmasq']]));
			html += this.row('dnsmasq_instance', 'Pick dnsmasq instance(s)',
				this.multiSelectCtl('dnsmasq_instance', this.instanceList('dhcp', 'dnsmasq')));
		}
		if (p.smartdns_installed && this.state.smartdns) {
			html += this.row('smartdns_instance_option', 'Ad-blocking on SmartDNS instance(s)',
				this.selectCtl('smartdns_instance_option', [['*', 'All instances'], ['+', 'Select instances'], ['-', 'No ad-blocking on SmartDNS']]));
			html += this.row('smartdns_instance', 'Pick SmartDNS instance(s)',
				this.multiSelectCtl('smartdns_instance', this.instanceList('smartdns', 'smartdns')));
		}

		html += this.row('force_dns', 'Force Router DNS',
			this.selectCtl('force_dns', [['0', "Let local devices use their own DNS servers if set"], ['1', 'Force Router DNS server to all local devices']]),
			'Forces Router DNS use on local devices, also known as DNS Hijacking.');
		html += this.row('verbosity', 'Output Verbosity',
			this.selectCtl('verbosity', [['0', 'Suppress output'], ['1', 'Some output'], ['2', 'Verbose output']]),
			'Controls system log and console output verbosity.');

		if (p.leds && p.leds.length) {
			html += this.row('led', 'LED to indicate status',
				this.selectCtl('led', [['', 'none'], ...p.leds.map(l => [l, l])]),
				'Pick an LED not already used in System LED Configuration.');
		}
		html += `</div>`;
		return html;
	}

	advancedMarkup() {
		let html = `<div class="stat-card">`;
		html += this.row('config_update_enabled', 'Automatic Config Update',
			this.selectCtl('config_update_enabled', [['0', 'Disable'], ['1', 'Enable']]),
			'Perform config update before downloading the block/allow-lists.');
		html += this.row('ipv6_enabled', 'IPv6 Support',
			this.selectCtl('ipv6_enabled', [['', 'Do not add IPv6 entries'], ['1', 'Add IPv6 entries']]),
			'Add IPv6 entries to block-list (dnsmasq.addnhosts / dnsmasq.nftset only).');
		html += this.row('download_timeout', 'Download time-out (seconds)', this.inputCtl('download_timeout', '20'),
			'Stop the download if it is stalled for set number of seconds (1-60).');
		html += this.row('download_connect_timeout', 'Connect time-out (seconds)', this.inputCtl('download_connect_timeout', '10'),
			'Stop the download if the connection cannot be established within this many seconds (curl/GNU wget only, 1-60).');
		html += this.row('download_max_time', 'Maximum download time (seconds)', this.inputCtl('download_max_time'),
			'Abort the whole transfer if it takes longer than this. Empty to disable (curl only).');
		html += this.row('download_allow_insecure', 'Allow insecure downloads',
			this.selectCtl('download_allow_insecure', [['0', 'Disable'], ['1', 'Enable']]),
			'Skip SSL certificate verification when downloading block-lists.');
		html += this.row('pause_timeout', 'Pause time-out (seconds)', this.inputCtl('pause_timeout', '20'),
			'Pause ad-blocking for this many seconds when the Pause button is pressed (1-600).');
		html += this.row('curl_max_file_size', 'Curl maximum file size (bytes)', this.inputCtl('curl_max_file_size'),
			'If curl is detected, it will not download files bigger than this.');
		html += this.row('curl_retry', 'Curl download retry', this.inputCtl('curl_retry', '3'),
			'If curl is detected, retry the download this many times on timeout/fail (0-30).');
		html += this.row('parallel_downloads', 'Simultaneous processing',
			this.selectCtl('parallel_downloads', [['0', 'Disabled'], ...this.rangeOptions(1, 16)]),
			'Max number of block lists to download/process at once. Auto-reduced when free memory is low.');
		html += this.row('compressed_cache', 'Store compressed cache file on router',
			this.selectCtl('compressed_cache', [['0', 'Do not store compressed cache'], ['1', 'Store compressed cache']]),
			'Attempt to create a compressed cache of block-list in persistent memory.');
		html += this.row('compressed_cache_dir', 'Directory for compressed cache file', this.inputCtl('compressed_cache_dir', '/etc'));
		html += this.row('dnsmasq_sanity_check', 'Enable dnsmasq sanity check',
			this.selectCtl('dnsmasq_sanity_check', [['0', 'Disable'], ['1', 'Enable']]),
			'Detect and report issues during dnsmasq block-list processing.');
		html += this.row('dnsmasq_validity_check', 'Enable dnsmasq domain validation',
			this.selectCtl('dnsmasq_validity_check', [['0', 'Disable'], ['1', 'Enable']]),
			'RFC 1123 compliant domain validation to remove invalid entries.');
		html += this.row('debug', 'Enable Debugging',
			this.selectCtl('debug', [['0', 'Disable Debugging'], ['1', 'Enable Debugging']]),
			`Enables debug output to /tmp/${PKG}.log.`);
		html += `</div>`;
		return html;
	}

	listsMarkup() {
		let html = `<div class="stat-card">
			<h2>Allowed and Blocked Domains</h2>
			${this.row('allowed_domain', 'Allowed Domains',
				`<textarea class="form-input adbf-textarea" id="adbf-opt-allowed_domain" placeholder="one domain per line"></textarea>`,
				'Individual domains to be allowed (one per line).')}
			${this.row('blocked_domain', 'Blocked Domains',
				`<textarea class="form-input adbf-textarea" id="adbf-opt-blocked_domain" placeholder="one domain per line"></textarea>`,
				'Individual domains to be blocked (one per line).')}
		</div>
		<div class="stat-card">
			<div class="adbf-section-head">
				<h2>Allowed and Blocked List URLs</h2>
				<button class="action-btn" id="adbf-add-url">ADD URL</button>
			</div>
			<p class="adbf-muted">URLs to file(s) containing lists to be allowed or blocked.</p>
			<table class="data-table" id="adbf-url-table">
				<thead><tr><th>Enabled</th><th>Action</th><th>Name / URL</th><th>Size</th><th></th></tr></thead>
				<tbody></tbody>
			</table>
		</div>`;
		return html;
	}

	scheduleMarkup() {
		let html = `<div class="stat-card">
			<p class="adbf-muted">The schedule is stored in the crontab (not UCI) and applied via the backend when you save.</p>`;
		html += this.row('auto_update_enabled', 'Automatic List Update',
			this.selectCtl('auto_update_enabled', [['0', 'Disable'], ['1', 'Enable']]),
			`Enable scheduled list redownloads via /etc/init.d/${PKG} dl.`);
		html += this.row('auto_update_mode', 'Schedule Type',
			this.selectCtl('auto_update_mode', [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['every_n_days', 'Every N days'], ['every_n_hours', 'Every N hours']]),
			'Select how often the update should run.');
		html += this.row('auto_update_every_ndays', 'Every N days', this.selectCtl('auto_update_every_ndays', this.rangeOptions(1, 31)), 'Run once every N days.');
		html += this.row('auto_update_every_nhours', 'Every N hours', this.selectCtl('auto_update_every_nhours', this.rangeOptions(1, 23)), 'Run once every N hours.');
		html += this.row('auto_update_weekday', 'Day of Week',
			this.selectCtl('auto_update_weekday', [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']]));
		html += this.row('auto_update_monthday', 'Day of Month', this.selectCtl('auto_update_monthday', this.rangeOptions(1, 31)));
		html += this.row('auto_update_hour', 'Update Hour', this.selectCtl('auto_update_hour', this.rangeOptions(0, 23, true)), 'Hour of day to run the update.');
		html += this.row('auto_update_minute', 'Update Minute', this.selectCtl('auto_update_minute', this.rangeOptions(0, 59, true)), 'Minute of hour to run the update.');
		html += `</div>`;
		return html;
	}

	logMarkup() {
		return `<div class="stat-card">
			<div class="adbf-log-head">
				<span>Query logging for <strong id="adbf-log-resolver">dnsmasq</strong>:
					<span id="adbf-log-status" class="adbf-log-state">Disabled</span></span>
				<span>
					<button class="action-btn" id="adbf-log-enable">ENABLE LOGGING</button>
					<button class="action-btn danger" id="adbf-log-disable">DISABLE LOGGING</button>
				</span>
			</div>
			<p class="adbf-muted" id="adbf-log-hint">Log refreshes automatically.</p>
			<textarea class="form-input adbf-querylog" id="adbf-querylog" readonly wrap="off"></textarea>
		</div>`;
	}

	urlModalMarkup() {
		return `<div class="modal hidden" id="adbf-url-modal">
			<div class="modal-backdrop"></div>
			<div class="modal-content">
				<div class="modal-header">
					<h3 class="modal-title">LIST URL</h3>
					<button class="modal-close" id="adbf-url-close">&times;</button>
				</div>
				<div class="modal-body">
					<input type="hidden" id="adbf-url-section" />
					<div class="form-group">
						<label class="form-label" for="adbf-url-enabled" style="display:flex;align-items:center;gap:8px;cursor:pointer">
							<input type="checkbox" id="adbf-url-enabled" checked /> Enabled
						</label>
					</div>
					<div class="form-group">
						<label class="form-label" for="adbf-url-action">Action</label>
						<select class="form-input" id="adbf-url-action">
							<option value="block">Block</option>
							<option value="allow">Allow</option>
						</select>
					</div>
					<div class="form-group">
						<label class="form-label" for="adbf-url-name">Name (optional)</label>
						<input type="text" class="form-input" id="adbf-url-name" />
					</div>
					<div class="form-group">
						<label class="form-label" for="adbf-url-url">URL</label>
						<input type="text" class="form-input" id="adbf-url-url" placeholder="https://example.com/list.txt" />
					</div>
				</div>
				<div class="modal-footer">
					<button class="action-btn" id="adbf-url-cancel">CANCEL</button>
					<button class="action-btn" id="adbf-url-save">SAVE</button>
				</div>
			</div>
		</div>`;
	}

	multiSelectCtl(name, items) {
		const opts = items.map(it => `<option value="${this.core.escapeHtml(it[0])}">${this.core.escapeHtml(it[1])}</option>`).join('');
		return `<select class="form-input adbf-multi" id="adbf-opt-${name}" multiple size="4">${opts}</select>`;
	}

	instanceList(config, type) {
		const values = config === 'dhcp' ? this.state.dhcp : this.state.smartdns;
		if (!values) return [];
		const out = [];
		let idx = 0;
		for (const [key, v] of Object.entries(values)) {
			if (v['.type'] !== type) continue;
			const anonymous = v['.anonymous'] || /^cfg[0-9a-f]+$/.test(key);
			const id = anonymous ? String(idx) : key;
			const label = anonymous ? `${type}[${idx}]` : key;
			out.push([id, label]);
			idx++;
		}
		return out;
	}

	// ── status panel ────────────────────────────────────────────────────

	async renderStatus() {
		const card = document.getElementById('adbf-status');
		if (!card) return;
		const st = this.state.init;
		const cron = this.state.cron;

		const warnings = st.warnings ? [...st.warnings] : [];
		const errors = st.errors || [];

		// Re-create the version-mismatch handshake (package / app / rpcd).
		if (st.packageCompat !== APP_COMPAT || st.rpcdCompat !== APP_COMPAT || st.packageCompat !== st.rpcdCompat) {
			warnings.push({ code: 'warningInternalVersionMismatch', info: [st.packageCompat || 0, APP_COMPAT, st.rpcdCompat || 0] });
		}
		if (st.enabled && st.running && (cron.auto_update_enabled || cron.cron_line_state === 'suspended')) {
			const cmd = '/etc/init.d/cron enable && /etc/init.d/cron start';
			if (!cron.cron_init || !cron.cron_bin) warnings.push({ code: 'warningCronMissing', info: cmd });
			else if (!cron.cron_enabled || !cron.cron_running) warnings.push({ code: 'warningCronDisabled', info: cmd });
		}

		let statusText;
		if (st.version) {
			statusText = `Version ${this.core.escapeHtml(st.version)} - `;
			const label = STATUS_TABLE[st.status] || 'Unknown';
			if (st.status === 'statusStopped' && !st.enabled) statusText += `${label} (Disabled).`;
			else if (['statusRestarting', 'statusForceReloading', 'statusDownloading', 'statusProcessing'].includes(st.status)) statusText += `${label}...`;
			else statusText += `${label}.`;
		} else {
			statusText = 'Not installed or not found';
		}

		let details = '';
		if (st.version && st.status === 'statusSuccess') {
			details += `Blocking ${this.core.escapeHtml(String(st.entries ?? '?'))} domains (with ${this.core.escapeHtml(st.dns || '')}).`;
			if (st.outputGzipExists) details += '<br />Compressed cache file created.';
			if (st.force_dns_active) details += '<br />Force DNS ports:' + (st.force_dns_ports || []).map(p => ' ' + this.core.escapeHtml(String(p))).join('') + '.';
		} else if (st.version && st.status === 'statusStopped') {
			if (st.outputCacheExists) details += 'Cache file found.';
			else if (st.outputGzipExists) details += 'Compressed cache file found.';
		}

		const warnHtml = warnings.map(w => fmtMessage(WARNING_TABLE[w.code] || 'Unknown warning', w.info)).join('<br />');
		const errHtml = errors.map(e => fmtMessage(ERROR_TABLE[e.code] || 'Unknown error', e.info)).join('<br />');

		// LuCI-style label/value rows (no redundant heading/divider). Each row is
		// a left "Service …" title and a right value, mirroring the LuCI overview.
		const row = (label, valueHtml) =>
			`<div class="adbf-row"><div class="adbf-row-label">${label}</div><div class="adbf-row-value">${valueHtml}</div></div>`;

		// Service-control buttons, enabled/disabled to match service state.
		const b = this.buttonStates(st);
		const pauseLabel = `Pause (${fmtPause(st.pause_timeout)})`;
		const buttons = `<div class="adbf-buttons">
			<button class="action-btn" data-act="start" ${b.start ? '' : 'disabled'}>Start</button>
			<button class="action-btn" data-act="dl" ${b.dl ? '' : 'disabled'}>Redownload</button>
			<button class="action-btn" data-act="pause" ${b.pause ? '' : 'disabled'}>${pauseLabel}</button>
			<button class="action-btn danger" data-act="stop" ${b.stop ? '' : 'disabled'}>Stop</button>
			<span class="adbf-btn-gap"></span>
			<button class="action-btn" data-act="enable" ${b.enable ? '' : 'disabled'}>Enable</button>
			<button class="action-btn danger" data-act="disable" ${b.disable ? '' : 'disabled'}>Disable</button>
		</div>`;

		let detailsVal = '';
		if (details) {
			detailsVal = `<span class="adbf-muted">${details}</span>`;
			if (st.version && st.status === 'statusSuccess') {
				detailsVal += `<div class="adbf-muted">Please <a href="${URL}#donate" target="_blank" rel="noopener">donate</a> to support development of this project.</div>`;
			}
		}

		let html = row('Service Status', `<span class="adbf-status-line">${statusText}</span>`);
		if (detailsVal) html += row('Service Details', detailsVal);
		if (warnHtml) html += row('Service Warnings', `<div class="adbf-warn">${warnHtml}</div>`);
		if (errHtml) html += row('Service Errors', `<div class="adbf-err">${errHtml} Errors encountered, please check the <a href="${URL}" target="_blank" rel="noopener">README</a>.</div>`);
		html += row('Service Control', buttons);

		card.innerHTML = html;
		card.querySelectorAll('button[data-act]').forEach(btn => {
			btn.addEventListener('click', () => this.serviceAction(btn.getAttribute('data-act')));
		});
	}

	buttonStates(st) {
		if (!st.enabled) return { start: false, dl: false, pause: false, stop: false, enable: true, disable: false };
		switch (st.status) {
			case 'statusSuccess':
				return { start: false, dl: true, pause: true, stop: true, enable: false, disable: true };
			case 'statusStopped':
				return { start: true, dl: true, pause: false, stop: false, enable: false, disable: true };
			default:
				return { start: false, dl: false, pause: false, stop: false, enable: false, disable: false };
		}
	}

	async serviceAction(action) {
		try {
			await this.rpc('setInitAction', { action });
		} catch {
			/* fire-and-forget actions may time out; the poll below tracks the real outcome */
		}
		this.core.showToast(`adblock-fast: ${action}`, 'info');
		// enable/disable/stop flip page structure (config visibility) → full reload.
		const structural = action === 'enable' || action === 'disable' || action === 'stop' || action === 'start';
		await this.pollUntilSettled();
		if (structural) await this.render();
		else this.refreshStatus();
	}

	async pollUntilSettled(maxAttempts = 120) {
		for (let i = 0; i < maxAttempts; i++) {
			await new Promise(r => setTimeout(r, 1000));
			try {
				const res = await this.rpc('getInitStatus');
				const status = res[PKG] && res[PKG].status;
				if (SETTLED.has(status)) return;
			} catch {
				/* keep polling */
			}
		}
	}

	async refreshStatus() {
		try {
			const [init, cron] = await Promise.all([this.rpc('getInitStatus'), this.rpc('getCronStatus').catch(() => ({}))]);
			this.state.init = init[PKG] || {};
			this.state.cron = cron[PKG] || {};
			this.state.platform = this.state.init.platform || {};
			this.renderStatus();
		} catch {
			/* leave last-known status on transient errors */
		}
	}

	startStatusPolling() {
		this.statusTimer = setInterval(() => {
			if (!this.visible()) return;
			// Don't churn while a long-running op is in flight (handled by pollUntilSettled).
			if (!SETTLED.has(this.state.init.status) && this.state.init.status != null) return;
			this.refreshStatus();
		}, 5000);
	}

	// ── config form ─────────────────────────────────────────────────────

	setVal(name, value) {
		const el = document.getElementById(`adbf-opt-${name}`);
		if (el) el.value = value == null ? '' : value;
	}

	getVal(name) {
		const el = document.getElementById(`adbf-opt-${name}`);
		return el ? el.value : undefined;
	}

	fillConfigForm() {
		const c = this.state.config;
		const def = (k, d) => (c[k] != null && c[k] !== '' ? c[k] : d);

		// Basic
		this.setVal('dns', def('dns', 'dnsmasq.servers'));
		this.setVal('dnsmasq_config_file_url', c.dnsmasq_config_file_url || '');
		this.setVal('force_dns', def('force_dns', '1'));
		this.setVal('verbosity', def('verbosity', '2'));
		if (document.getElementById('adbf-opt-led')) this.setVal('led', c.led || '');

		this.fillInstance('dnsmasq_instance');
		this.fillInstance('smartdns_instance');

		// Advanced
		this.setVal('config_update_enabled', def('config_update_enabled', '0'));
		this.setVal('ipv6_enabled', c.ipv6_enabled === '1' ? '1' : '');
		this.setVal('download_timeout', def('download_timeout', '20'));
		this.setVal('download_connect_timeout', def('download_connect_timeout', '10'));
		this.setVal('download_max_time', c.download_max_time || '');
		this.setVal('download_allow_insecure', def('download_allow_insecure', '1'));
		this.setVal('pause_timeout', def('pause_timeout', '20'));
		this.setVal('curl_max_file_size', c.curl_max_file_size || '');
		this.setVal('curl_retry', def('curl_retry', '3'));
		this.setVal('parallel_downloads', def('parallel_downloads', '8'));
		this.setVal('compressed_cache', def('compressed_cache', '0'));
		this.setVal('compressed_cache_dir', def('compressed_cache_dir', '/etc'));
		this.setVal('dnsmasq_sanity_check', def('dnsmasq_sanity_check', '1'));
		this.setVal('dnsmasq_validity_check', def('dnsmasq_validity_check', '0'));
		this.setVal('debug', def('debug', '0'));

		// Lists (config-level list options)
		this.setVal('allowed_domain', this.asList(c.allowed_domain).join('\n'));
		this.setVal('blocked_domain', this.asList(c.blocked_domain).join('\n'));

		// Schedule (parsed from crontab, never from UCI)
		const sched = parseCronEntry(this.state.cron.entry || '');
		Object.entries(sched).forEach(([k, v]) => this.setVal(k, v));

		// Query log
		this.fillQueryLog();

		this.applyVisibility();
	}

	asList(v) {
		if (v == null) return [];
		return Array.isArray(v) ? v.slice() : String(v).split(/\s+/).filter(Boolean);
	}

	fillInstance(name) {
		const sel = document.getElementById(`adbf-opt-${name}`);
		const optSel = document.getElementById(`adbf-opt-${name}_option`);
		if (!sel || !optSel) return;
		const raw = this.asList(this.state.config[name]);
		let mode = '*';
		if (raw.length === 1 && (raw[0] === '*' || raw[0] === '-')) mode = raw[0];
		else if (raw.length) mode = '+';
		optSel.value = mode;
		if (mode === '+') {
			const set = new Set(raw);
			[...sel.options].forEach(o => (o.selected = set.has(o.value)));
		}
	}

	fillQueryLog() {
		const q = this.state.qlog;
		const resolver = q.resolver || 'dnsmasq';
		const resolverEl = document.getElementById('adbf-log-resolver');
		const stateEl = document.getElementById('adbf-log-status');
		if (resolverEl) resolverEl.textContent = resolver;
		if (stateEl) {
			stateEl.textContent = q.logging_enabled ? 'Enabled' : 'Disabled';
			stateEl.classList.toggle('on', !!q.logging_enabled);
		}
		const en = document.getElementById('adbf-log-enable');
		const dis = document.getElementById('adbf-log-disable');
		if (en) en.disabled = !!q.logging_enabled;
		if (dis) dis.disabled = !q.logging_enabled;
	}

	// Conditional row visibility mirroring the LuCI depends() rules.
	applyVisibility() {
		const dns = this.getVal('dns') || '';
		const show = (name, cond) => {
			const row = document.getElementById(`adbf-row-${name}`);
			if (row) row.classList.toggle('hidden', !cond);
		};
		show('dnsmasq_config_file_url', dns === 'dnsmasq.conf');
		show('ipv6_enabled', dns === 'dnsmasq.addnhosts' || dns === 'dnsmasq.nftset');
		show('compressed_cache_dir', this.getVal('compressed_cache') === '1');

		// Instance multiselects only when option == '+'
		['dnsmasq_instance', 'smartdns_instance'].forEach(n => {
			const opt = document.getElementById(`adbf-opt-${n}_option`);
			if (opt) show(n, opt.value === '+');
		});

		// Schedule field visibility by mode
		const en = this.getVal('auto_update_enabled') === '1';
		const mode = this.getVal('auto_update_mode');
		show('auto_update_mode', en);
		show('auto_update_every_ndays', en && mode === 'every_n_days');
		show('auto_update_every_nhours', en && mode === 'every_n_hours');
		show('auto_update_weekday', en && mode === 'weekly');
		show('auto_update_monthday', en && mode === 'monthly');
		show('auto_update_hour', en && ['daily', 'weekly', 'monthly', 'every_n_days'].includes(mode));
		show('auto_update_minute', en);
	}

	// ── handlers ────────────────────────────────────────────────────────

	attachHandlers() {
		// Tabs
		this.page.querySelectorAll('#adbf-tabs .tab-btn').forEach(btn => {
			btn.addEventListener('click', () => this.switchTab(btn.getAttribute('data-tab')));
		});
		// Visibility-affecting controls
		['dns', 'compressed_cache', 'auto_update_enabled', 'auto_update_mode',
			'dnsmasq_instance_option', 'smartdns_instance_option'].forEach(n => {
			const el = document.getElementById(`adbf-opt-${n}`);
			if (el) el.addEventListener('change', () => this.applyVisibility());
		});

		// Save buttons per tab live in a shared footer added here.
		this.addSaveFooter('tab_basic');
		this.addSaveFooter('tab_advanced');
		this.addSaveFooter('tab_lists');
		this.addSaveFooter('tab_schedule');

		// URL table CRUD
		document.getElementById('adbf-add-url')?.addEventListener('click', () => this.openUrlModal(null));
		document.getElementById('adbf-url-close')?.addEventListener('click', () => this.core.closeModal('adbf-url-modal'));
		document.getElementById('adbf-url-cancel')?.addEventListener('click', () => this.core.closeModal('adbf-url-modal'));
		document.getElementById('adbf-url-save')?.addEventListener('click', () => this.saveUrl());
		this.core.delegateActions('adbf-url-table', {
			edit: id => this.openUrlModal(id),
			delete: id => this.deleteUrl(id)
		});

		// Query log buttons
		document.getElementById('adbf-log-enable')?.addEventListener('click', () => this.setQueryLog('enable'));
		document.getElementById('adbf-log-disable')?.addEventListener('click', () => this.setQueryLog('disable'));
	}

	addSaveFooter(tabId) {
		const tab = document.getElementById(tabId);
		if (!tab) return;
		const footer = document.createElement('div');
		footer.className = 'quick-actions adbf-save-row';
		const label = tabId === 'tab_schedule' ? 'SAVE SCHEDULE' : 'SAVE & APPLY';
		footer.innerHTML = `<button class="action-btn" data-save="${tabId}">${label}</button>`;
		tab.appendChild(footer);
		footer.querySelector('button').addEventListener('click', () => {
			if (tabId === 'tab_schedule') this.saveSchedule();
			else this.saveConfig();
		});
	}

	switchTab(tab) {
		this.activeTab = tab;
		this.page.querySelectorAll('#adbf-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
		this.page.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== tab));
		if (tab === 'tab_log') this.startLogPolling();
		else this.stopLogPolling();
	}

	// ── saving ──────────────────────────────────────────────────────────

	collectConfigValues() {
		const values = {};
		const simple = ['dns', 'force_dns', 'verbosity', 'config_update_enabled',
			'download_timeout', 'download_connect_timeout', 'download_allow_insecure',
			'pause_timeout', 'curl_retry', 'parallel_downloads', 'compressed_cache',
			'compressed_cache_dir', 'dnsmasq_sanity_check', 'dnsmasq_validity_check', 'debug'];
		simple.forEach(n => {
			const v = this.getVal(n);
			if (v !== undefined) values[n] = v;
		});

		// Optional values: empty means "remove" — represent as empty string.
		['dnsmasq_config_file_url', 'download_max_time', 'curl_max_file_size', 'ipv6_enabled', 'led'].forEach(n => {
			const el = document.getElementById(`adbf-opt-${n}`);
			if (el) values[n] = el.value || '';
		});

		// Domain lists
		values.allowed_domain = this.textareaList('allowed_domain');
		values.blocked_domain = this.textareaList('blocked_domain');

		// Instance selection
		this.collectInstance('dnsmasq_instance', values);
		this.collectInstance('smartdns_instance', values);

		return values;
	}

	textareaList(name) {
		const el = document.getElementById(`adbf-opt-${name}`);
		if (!el) return [];
		return el.value.split('\n').map(s => s.trim()).filter(Boolean);
	}

	collectInstance(name, values) {
		const optSel = document.getElementById(`adbf-opt-${name}_option`);
		const sel = document.getElementById(`adbf-opt-${name}`);
		if (!optSel || !sel) return;
		const mode = optSel.value;
		if (mode === '*' || mode === '-') values[name] = [mode];
		else values[name] = [...sel.selectedOptions].map(o => o.value);
	}

	async saveConfig() {
		const values = this.collectConfigValues();
		try {
			await this.core.uciSet(PKG, 'config', values);
			await this.core.uciCommit(PKG);
		} catch {
			this.core.showToast('Failed to save configuration', 'error');
			return;
		}
		this.core.showToast('Configuration saved', 'success');
		// Apply: reload the service so changes take effect (matches LuCI Save & Apply
		// triggering the adblock-fast procd reload), then refresh status.
		if (this.state.init.enabled) {
			try {
				await this.rpc('setInitAction', { action: 'reload' });
			} catch {}
		}
		// Re-read config so subsequent edits and visibility stay consistent.
		const cfg = await this.uciValues(PKG);
		this.state.cfg = cfg || {};
		this.state.config = (cfg && cfg.config) || {};
		await this.pollUntilSettled();
		this.refreshStatus();
	}

	collectSchedule() {
		const fields = ['auto_update_enabled', 'auto_update_mode', 'auto_update_hour',
			'auto_update_minute', 'auto_update_weekday', 'auto_update_monthday',
			'auto_update_every_ndays', 'auto_update_every_nhours'];
		const schedule = {};
		fields.forEach(f => {
			const row = document.getElementById(`adbf-row-${f}`);
			// Hidden (mode-irrelevant) fields are omitted; the backend fills defaults.
			if (row && row.classList.contains('hidden')) return;
			const v = this.getVal(f);
			if (v != null && v !== '') schedule[f] = v;
		});
		if (schedule.auto_update_enabled == null) schedule.auto_update_enabled = '0';
		return schedule;
	}

	async saveSchedule() {
		try {
			const res = await this.rpc('syncCron', this.collectSchedule());
			if (res.result === false) throw new Error('syncCron rejected');
			this.core.showToast('Schedule updated', 'success');
			const cron = await this.rpc('getCronStatus').catch(() => ({}));
			this.state.cron = cron[PKG] || {};
		} catch {
			this.core.showToast('Failed to update cron schedule', 'error');
		}
	}

	// ── URL list CRUD ───────────────────────────────────────────────────

	urlSections() {
		return Object.entries(this.state.cfg)
			.filter(([, v]) => v['.type'] === 'file_url')
			.map(([section, v]) => ({ section, ...v }));
	}

	sizeFor(url) {
		const hit = (this.state.sizes || []).find(e => e.url === url);
		return hit && hit.size ? humanFileSize(hit.size) : 'Unknown';
	}

	renderUrlTable() {
		const rows = this.urlSections();
		this.core.renderTable('#adbf-url-table', rows, 5, 'No list URLs configured.', r => {
			const name = r.name || r.url || '';
			const action = r.action === 'allow'
				? this.core.renderBadge('success', 'ALLOW')
				: this.core.renderBadge('error', 'BLOCK');
			const en = r.enabled === '0'
				? this.core.renderBadge('warning', 'OFF')
				: this.core.renderBadge('success', 'ON');
			return `<tr>
				<td>${en}</td>
				<td>${action}</td>
				<td>${this.core.escapeHtml(name)}</td>
				<td>${this.core.escapeHtml(this.sizeFor(r.url))}</td>
				<td>${this.core.renderActionButtons(r.section)}</td>
			</tr>`;
		});
	}

	openUrlModal(section) {
		this.core.resetModal('adbf-url-modal');
		document.getElementById('adbf-url-section').value = section || '';
		if (section) {
			const v = this.state.cfg[section] || {};
			document.getElementById('adbf-url-enabled').checked = v.enabled !== '0';
			document.getElementById('adbf-url-action').value = v.action === 'allow' ? 'allow' : 'block';
			document.getElementById('adbf-url-name').value = v.name || '';
			document.getElementById('adbf-url-url').value = v.url || '';
		}
		this.core.openModal('adbf-url-modal');
	}

	async saveUrl() {
		const section = document.getElementById('adbf-url-section').value;
		const url = document.getElementById('adbf-url-url').value.trim();
		if (!url) {
			this.core.showToast('URL is required', 'error');
			return;
		}
		const values = {
			enabled: document.getElementById('adbf-url-enabled').checked ? '1' : '0',
			action: document.getElementById('adbf-url-action').value,
			name: document.getElementById('adbf-url-name').value.trim(),
			url
		};
		try {
			if (section) {
				await this.core.uciSet(PKG, section, values);
			} else {
				const [, res] = await this.core.uciAdd(PKG, 'file_url');
				if (!res?.section) throw new Error('add failed');
				await this.core.uciSet(PKG, res.section, values);
			}
			await this.core.uciCommit(PKG);
		} catch {
			this.core.showToast('Failed to save URL', 'error');
			return;
		}
		this.core.closeModal('adbf-url-modal');
		this.core.showToast('Saved', 'success');
		await this.reloadCfg();
		this.renderUrlTable();
	}

	async deleteUrl(section) {
		if (!confirm('Delete this list URL?')) return;
		try {
			await this.core.uciDelete(PKG, section);
			await this.core.uciCommit(PKG);
		} catch {
			this.core.showToast('Failed to delete', 'error');
			return;
		}
		this.core.showToast('Deleted', 'success');
		await this.reloadCfg();
		this.renderUrlTable();
	}

	async reloadCfg() {
		const cfg = await this.uciValues(PKG);
		this.state.cfg = cfg || {};
		this.state.config = (cfg && cfg.config) || {};
	}

	// ── query log ───────────────────────────────────────────────────────

	async setQueryLog(action) {
		try {
			await this.rpc('setQueryLog', { action });
			this.core.showToast(`Query logging ${action}d`, 'success');
		} catch {
			this.core.showToast('Failed to change query logging', 'error');
			return;
		}
		const qlog = await this.rpc('getQueryLogStatus').catch(() => ({}));
		this.state.qlog = qlog[PKG] || {};
		this.fillQueryLog();
	}

	startLogPolling() {
		this.fetchLog();
		if (this.logTimer) clearInterval(this.logTimer);
		this.logTimer = setInterval(() => {
			if (this.visible() && this.activeTab === 'tab_log') this.fetchLog();
		}, 5000);
	}

	stopLogPolling() {
		if (this.logTimer) clearInterval(this.logTimer);
		this.logTimer = null;
	}

	async fetchLog() {
		const el = document.getElementById('adbf-querylog');
		if (!el) return;
		const resolver = this.state.qlog.resolver || 'dnsmasq';
		const tag = resolver === 'smartdns' ? 'smartdns' : resolver === 'unbound' ? 'unbound' : 'dnsmasq';
		try {
			const res = await this.core.ubusCall('log', 'read', { lines: 1000, stream: false, oneshot: true });
			const entries = (res && res[0] === 0 && res[1] && res[1].log) || [];
			const lines = entries
				.filter(e => e.msg && e.msg.indexOf(tag) >= 0)
				.map(e => {
					const d = new Date(e.time);
					return `[${d.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })}-${d.toLocaleTimeString([], { hour12: false })}] ${e.msg}`;
				});
			el.value = lines.length ? lines.join('\n') : `No ${resolver} query log entries found.`;
			el.scrollTop = el.scrollHeight;
		} catch {
			el.value = 'Failed to read system log.';
		}
	}
}
