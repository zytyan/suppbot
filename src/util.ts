export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// No shell interpolation; abort terminates the external media process, too.
export async function command(
  program: string,
  args: string[],
  signal: AbortSignal,
  progress?: (text: string) => void,
): Promise<string> {
  signal.throwIfAborted();
  const child = new Deno.Command(program, { args, signal, stdin: 'null', stdout: 'piped', stderr: 'piped' })
    .spawn();
  const read = async (
    stream: ReadableStream<Uint8Array>,
    limit: number,
    callback?: (text: string) => void,
  ) => {
    let output = '';
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      output = (output + chunk).slice(-limit);
      callback?.(chunk);
    }
    return output;
  };
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    read(child.stdout, 2_000_000, progress),
    read(child.stderr, 8000),
  ]);
  signal.throwIfAborted();
  if (!status.success) throw new Error(`${program} exited ${status.code}: ${stderr}`);
  return stdout;
}

export const naturalSort = (files: string[]): string[] =>
  files.sort(new Intl.Collator('en', { numeric: true }).compare);
