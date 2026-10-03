/**
 * Incremental Server-Sent Events parser. Feed it raw text chunks as they arrive;
 * it returns the `data:` payloads of every event completed so far.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r?\n/)) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + (this.buffer[newline] === '\r' ? 2 : 1));
      this.consumeLine(line, events);
    }
    return events;
  }

  /** Flush a trailing event when the stream ends without a blank line. */
  end(): string[] {
    const events: string[] = [];
    if (this.buffer.length) {
      this.consumeLine(this.buffer, events);
      this.buffer = '';
    }
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(events: string[]): void {
    if (this.dataLines.length) {
      events.push(this.dataLines.join('\n'));
      this.dataLines = [];
    }
  }
}
