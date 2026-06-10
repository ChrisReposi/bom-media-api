export type CloudinaryUploadResult = {
  assetId?: string;
  publicId: string;
  version?: number;
  format?: string;
  resourceType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  originalFilename?: string;
  secureUrl: string;
};

export type CloudinaryImageUploadInput = {
  fileBuffer: Buffer;
  originalFilename: string;
  folder?: string | undefined;
  tags?: string[] | undefined;
};

export type CloudinaryImageUploadResult = {
  assetId?: string;
  publicId: string;
  version?: number;
  format?: string;
  resourceType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  secureUrl: string;
};
