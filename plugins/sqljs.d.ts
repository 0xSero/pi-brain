declare module "sql.js" {
	export interface SqlJsStatement {
		bind(values?: ReadonlyArray<unknown> | Record<string, unknown>): boolean;
		step(): boolean;
		getAsObject(params?: ReadonlyArray<unknown> | Record<string, unknown>): Record<string, unknown>;
		free(): boolean;
	}

	export interface SqlJsDatabase {
		prepare(sql: string): SqlJsStatement;
		run(sql: string, params?: ReadonlyArray<unknown> | Record<string, unknown>): void;
		exec(
			sql: string,
			params?: ReadonlyArray<unknown> | Record<string, unknown>,
		): Array<{ columns: string[]; values: unknown[][] }>;
		export(): Uint8Array;
		close(): void;
	}

	export interface SqlJsStatic {
		Database: new (data?: Uint8Array | number[] | ArrayLike<number>) => SqlJsDatabase;
	}

	export interface SqlJsConfig {
		locateFile?: (file: string) => string;
	}

	const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
	export default initSqlJs;
}
