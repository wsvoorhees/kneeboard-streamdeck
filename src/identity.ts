// The plugin's identity, as its manifest declares it (a test holds the two together). One literal
// for the three places that used to restate the version: the manifest, the deck profile generator
// (every action it emits names the plugin version) and the doctor's installed-version check.
// Dependency-free on purpose: the generator and the doctor import it from outside the plugin.

export const PLUGIN_UUID = "com.willvoorhees.openkneeboard-configurator";
export const PLUGIN_NAME = "OpenKneeboard Configurator";
export const PLUGIN_VERSION = "0.4.0.0";
/** The three together, as the profile generator and the installer use them. */
export const PLUGIN_IDENTITY = { name: PLUGIN_NAME, uuid: PLUGIN_UUID, version: PLUGIN_VERSION } as const;

/**
 * The setting a profile generator stamps on the keys it writes, naming itself (Escargot, the rig
 * tool, writes "Escargot"). The plugin never acts on it; the settings panel only says the key was
 * generated, so a person editing it knows the next generation replaces the edit. A key made by hand
 * has none.
 */
export const GENERATED_BY = "generatedBy";
