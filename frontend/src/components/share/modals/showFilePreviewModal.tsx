import { ModalsContextProps } from "@mantine/modals/lib/context";
import shareService from "../../../services/share.service";
import { FileMetaData } from "../../../types/File.type";
import FilePreview from "../FilePreview";

const showFilePreviewModal = (
  shareId: string,
  file: FileMetaData,
  modals: ModalsContextProps,
) => {
  const mimeType = shareService.getFileMimeType(file.name);
  return modals.openModal({
    size: "xl",
    title: file.name,
    children: (
      <FilePreview shareId={shareId} fileId={file.id} mimeType={mimeType} />
    ),
  });
};

export default showFilePreviewModal;
