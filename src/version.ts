declare const __PLUGIN_VERSION__: string | undefined;

export const PLUGIN_VERSION =
  typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'development';
