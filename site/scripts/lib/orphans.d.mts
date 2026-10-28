/** The process table `ps` prints, as `readTable` keys it: pid → the fields the check reads. */
export type ProcessRow = { ppid: number; rss: number; etime: string; command: string };

/** A vitest process, and whether it still has the parent that would wait for it. */
export type TestProcess = { pid: number; ppid: number; mb: number; etime: string; live: boolean };

/** A node process that names vitest in a shape this check does not know. */
export type Unrecognised = { pid: number; command: string };

export function readTable(text: string): Map<number, ProcessRow>;
export function testProcesses(text: string): TestProcess[];
export function unrecognised(text: string): Unrecognised[];
