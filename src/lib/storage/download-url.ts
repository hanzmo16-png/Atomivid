/** Match Storage's download option while keeping the signed preview URL intact. */
export function asDownloadUrl(signedUrl: string, filename: string): string {
  const url = new URL(signedUrl);
  url.searchParams.set("download", filename);
  return url.toString();
}
