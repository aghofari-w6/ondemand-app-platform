/** Test database settings. CI and local runs use the same defaults. */
export const ADMIN_URL_ROOT = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const TEST_DB = process.env.TEST_DB ?? 'aod_test';
const u = new URL(ADMIN_URL_ROOT);
export const ADMIN_URL = `${u.protocol}//${u.username}:${u.password}@${u.host}/${TEST_DB}`;
export const APP_URL = `${u.protocol}//aod_app:${process.env.TEST_APP_PASSWORD ?? 'aod_app_dev'}@${u.host}/${TEST_DB}`;
