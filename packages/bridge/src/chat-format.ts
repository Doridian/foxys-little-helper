// Factorio chat shows markdown literally; turn the bits models habitually use into rich text.

export function toFactorioRichText(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "[font=default-bold]$1[/font]")
    .replace(/\*\*(.+?)\*\*/g, "[font=default-bold]$1[/font]")
    .replace(/__(.+?)__/g, "[font=default-bold]$1[/font]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
