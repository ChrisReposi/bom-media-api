export function buildCloudinaryVideoThumbnailUrl(
  cloudName: string,
  publicId: string,
): string {
  const encodedPublicId = publicId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `https://res.cloudinary.com/${encodeURIComponent(
    cloudName,
  )}/video/upload/so_1,w_640,c_fill/${encodedPublicId}.jpg`;
}
