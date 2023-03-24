import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Group,
  Progress,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { randomId, useViewportSize } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ModelStatus, ModelType } from '@prisma/client';
import {
  IconBan,
  IconCircleCheck,
  IconCloudUpload,
  IconFileUpload,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons';
import startCase from 'lodash/startCase';
import Link from 'next/link';
import { MasonryScroller, useContainerPosition, usePositioner, useResizeObserver } from 'masonic';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { constants, ModelFileType } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelVersionById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB, formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type ZodErrorSchema = { _errors: string[] };
type SchemaError = {
  type?: ZodErrorSchema;
  size?: ZodErrorSchema;
  fp?: ZodErrorSchema;
};

type DropzoneOptions = {
  acceptedFileTypes: string[];
  acceptedModelFiles: ModelFileType[];
  maxFiles: number;
};

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  Checkpoint: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Config', 'VAE', 'Training Data'],
    maxFiles: 11,
  },
  LORA: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 3,
  },
  LoCon: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 3,
  },
  TextualInversion: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Negative', 'Training Data'],
    maxFiles: 3,
  },
  Hypernetwork: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  AestheticGradient: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  Controlnet: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin'],
    acceptedModelFiles: ['Model'],
    maxFiles: 2,
  },
  Poses: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Wildcards: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Other: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
};

const metadataSchema = modelFileMetadataSchema
  .extend({
    versionId: z.number(),
    type: z.enum(constants.modelFileTypes),
  })
  .refine((data) => (data.type === 'Model' ? !!data.size : true), {
    message: 'Model size is required for model files',
    path: ['size'],
  })
  .refine((data) => (data.type === 'Model' ? !!data.fp : true), {
    message: 'Floating point is required for model files',
    path: ['fp'],
  })
  .array();

// TODO.manuel: This is a hacky way to check for duplicates
const checkConflictingFiles = (files: TrackedFile[]) => {
  const conflictCount: Record<string, number> = {};
  const data = files.map((file) => file.meta as { size: string; type: string; fp: string });

  data.forEach((item) => {
    const key = [item.size, item.type, item.fp].filter(Boolean).join('-');
    if (conflictCount[key]) conflictCount[key] += 1;
    else conflictCount[key] = 1;
  });

  return Object.values(conflictCount).every((count) => count === 1);
};

export function Files({ model, version, onStartUploadClick }: Props) {
  const theme = useMantineTheme();
  const { items, upload, setItems } = useS3UploadStore();
  const queryUtils = trpc.useContext();

  const versionFiles = items.filter((item) => item.meta?.versionId === version?.id);

  const masonryRef = useRef(null);
  const { width, height } = useViewportSize();
  const { offset, width: containerWidth } = useContainerPosition(masonryRef, [width, height]);
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: 2,
      columnGutter: theme.spacing.md,
    },
    [versionFiles.length]
  );
  const resizeObserver = useResizeObserver(positioner);

  const [error, setError] = useState<SchemaError[] | null>(null);

  const publishModelMutation = trpc.model.publish.useMutation({
    async onSuccess(_, variables) {
      hideNotification('publishing-version');

      const modelVersionId = variables.versionIds?.[0];
      const pubNotificationId = `version-published-${modelVersionId}`;
      showNotification({
        id: pubNotificationId,
        title: 'Version published',
        color: 'green',
        styles: { root: { alignItems: 'flex-start' } },
        message: (
          <Stack spacing={4}>
            <Text size="sm" color="dimmed">
              Your version has been published and is now available to the public.
            </Text>
            <Link href={`/models/v2/${variables.id}?modelVersionId=${modelVersionId}`} passHref>
              <Anchor size="sm" onClick={() => hideNotification(pubNotificationId)}>
                Go to model
              </Anchor>
            </Link>
          </Stack>
        ),
      });

      await queryUtils.model.getById.invalidate({ id: variables.id });
      if (modelVersionId)
        await queryUtils.modelVersion.getById.invalidate({
          id: modelVersionId,
        });
    },
    onError(error) {
      hideNotification('publishing-version');
      showErrorNotification({
        title: 'Failed to publish version',
        error: new Error(error.message),
      });
    },
  });
  const upsertFileMutation = trpc.modelFile.upsert.useMutation({
    async onSuccess(result) {
      useS3UploadStore
        .getState()
        .setItems((items) =>
          items.map((item) => (item.id === result.id ? { ...item, id: result.id } : item))
        );

      const hasPublishedPosts = result.modelVersion._count.posts > 0;
      const isVersionPublished = result.modelVersion.status === ModelStatus.Published;
      const { uploading } = useS3UploadStore
        .getState()
        .getStatus((item) => item.meta?.versionId === result.modelVersion.id);
      const stillUploading = uploading > 0;

      const notificationId = `upload-finished-${result.id}`;
      showNotification({
        id: notificationId,
        autoClose: stillUploading,
        color: 'green',
        title: `Finished uploading ${result.name}`,
        styles: { root: { alignItems: 'flex-start' } },
        message: !stillUploading ? (
          <Stack spacing={4}>
            {isVersionPublished ? (
              <>
                <Text size="sm" color="dimmed">
                  All files finished uploading.
                </Text>
                <Link
                  href={`/models/v2/${model?.id}?modelVersionId=${result.modelVersion.id}`}
                  passHref
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Go to model
                  </Anchor>
                </Link>
              </>
            ) : hasPublishedPosts ? (
              <>
                <Text size="sm" color="dimmed">
                  {`Your files have finished uploading, let's publish this version.`}
                </Text>
                <Text
                  variant="link"
                  size="sm"
                  sx={{ cursor: 'pointer' }}
                  onClick={() => {
                    hideNotification(notificationId);

                    showNotification({
                      id: 'publishing-version',
                      message: 'Publishing...',
                      loading: true,
                    });

                    publishModelMutation.mutate({
                      id: model?.id as number,
                      versionIds: [result.modelVersion.id],
                    });
                  }}
                >
                  Publish it
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" color="dimmed">
                  Your files have finished uploading, but you still need to add a post.
                </Text>
                <Link
                  href={`/models/v2/${model?.id}/model-versions/${result.modelVersion.id}/wizard?step=3`}
                  passHref
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Finish setup
                  </Anchor>
                </Link>
              </>
            )}
          </Stack>
        ) : undefined,
      });

      await queryUtils.modelVersion.getById.invalidate({ id: result.modelVersion.id });
      if (model) await queryUtils.model.getById.invalidate({ id: model.id });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to save file',
        reason: 'Could not save file, please try again.',
        error: new Error(error.message),
      });
    },
  });
  const handleStartUpload = async (files: TrackedFile[]) => {
    setError(null);

    const validation = metadataSchema.safeParse(versionFiles.map((item) => item.meta));
    if (!validation.success) {
      const errors = validation.error.format() as unknown as Array<{ [k: string]: ZodErrorSchema }>;
      setError(errors);
      return;
    }

    if (!checkConflictingFiles(files)) {
      return showErrorNotification({
        title: 'Duplicate file types',
        error: new Error(
          'There are multiple files with the same type and size, please adjust your files'
        ),
      });
    }

    onStartUploadClick?.();

    await Promise.all(
      files.map(({ file, meta }) => {
        const type = meta?.type === 'Model' ? UploadType.Model : UploadType.Default;

        return upload({ file, type, meta }, ({ meta, size, ...result }) => {
          const { versionId, type, ...metadata } = meta as {
            versionId: number;
            type: ModelFileType;
          };
          if (versionId)
            upsertFileMutation.mutate({
              ...result,
              sizeKB: bytesToKB(size),
              modelVersionId: versionId,
              type,
              metadata,
            });
        });
      })
    );
  };

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    setError(null);
    setItems((current) => [
      ...current,
      ...droppedFiles.map((file) => ({
        file,
        name: file.name,
        size: file.size ?? 0,
        status: 'pending' as const,
        uploaded: 0,
        progress: 0,
        speed: 0,
        timeRemaining: 0,
        abort: () => undefined,
        uuid: randomId(),
        meta: { versionId: version?.id },
      })),
    ]);
  };

  useEffect(() => {
    if (version && version.files && version.files.length > 0) {
      setItems((currentItems) => {
        // merge both currentItems and version.files, but replace the matching files
        // with the ones from version.files and adding the missing ones
        const versionFiles = currentItems.filter((item) => item.meta?.versionId === version?.id);
        const adjustedFiles =
          version.files?.map(({ id, sizeKB, name, type, metadata }) => ({
            id,
            name,
            size: sizeKB,
            uuid: randomId(),
            progress: 0,
            uploaded: 0,
            timeRemaining: 0,
            speed: 0,
            status: 'success' as const,
            abort: () => undefined,
            meta: { ...metadata, versionId: version?.id, type },
            file: new File([], name),
          })) ?? [];

        // merge adjustedFiles and versionFiles, but avoid duplicates
        const mergedFiles = [...versionFiles, ...adjustedFiles].reduce(
          (acc, file) => ({
            ...acc,
            [file.name]: file,
          }),
          {} as Record<string, TrackedFile>
        );

        return Object.values(mergedFiles);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.files]);

  const { acceptedModelFiles, acceptedFileTypes, maxFiles } =
    dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'];
  const hasPendingFiles = versionFiles.some((item) => item.status === 'pending');

  return (
    <Stack>
      <Dropzone
        accept={{ 'application/octet-stream': acceptedFileTypes }}
        onDrop={handleDrop}
        maxFiles={maxFiles}
      >
        <Group position="center" spacing="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFileUpload size={50} stroke={1.5} />
          </Dropzone.Idle>

          <Stack spacing={8}>
            <Text size="xl" inline>
              Drop your files here or click to select
            </Text>
            <Text size="sm" color="dimmed" inline>
              {`Attach up to ${maxFiles} files. Accepted file types: ${acceptedFileTypes.join(
                ', '
              )}`}
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      {versionFiles.length > 0 ? (
        <Button
          onClick={() =>
            handleStartUpload(versionFiles.filter((item) => item.status === 'pending'))
          }
          size="lg"
          disabled={!hasPendingFiles}
          fullWidth
        >
          Start Upload
        </Button>
      ) : null}
      <MasonryScroller
        containerRef={masonryRef}
        positioner={positioner}
        resizeObserver={resizeObserver}
        offset={offset}
        height={height}
        items={versionFiles}
        render={({ data, index }) => (
          <FileCard
            key={data.uuid}
            file={data}
            fileTypes={acceptedModelFiles}
            modelId={model?.id}
            error={error?.[index]}
            onRetry={handleStartUpload}
          />
        )}
      />
    </Stack>
  );
}

type Props = {
  model?: Partial<ModelUpsertInput>;
  version?: Partial<ModelVersionById>;
  onStartUploadClick?: VoidFunction;
};

type FileStatus = 'success' | 'pending' | 'error' | 'aborted';
const mapStatusLabel: Record<FileStatus, React.ReactNode> = {
  pending: (
    <>
      <IconCloudUpload />
      <Text size="sm">Pending upload</Text>
    </>
  ),
  error: (
    <>
      <IconBan color="red" />
      <Text size="sm">Failed to upload</Text>
    </>
  ),
  aborted: (
    <>
      <IconBan color="red" />
      <Text size="sm">Aborted upload</Text>
    </>
  ),
  success: (
    <>
      <IconCircleCheck color="green" />
      <Text size="sm">Upload completed</Text>
    </>
  ),
};

function FileCard({ file, fileTypes, error, modelId, onRetry }: FileCardProps) {
  const theme = useMantineTheme();
  const queryUtils = trpc.useContext();
  const clear = useS3UploadStore((state) => state.clear);
  const abort = useS3UploadStore((state) => state.abort);
  const updateMeta = useS3UploadStore((state) => state.updateMeta);

  const { uuid, status, name, progress, timeRemaining, speed, meta } = file;
  const { type, size, fp, versionId } = meta as {
    versionId: number;
    type: ModelFileType;
    size?: 'Full' | 'Pruned';
    fp?: 'fp16' | 'fp32';
  };
  const failedUpload = status === 'error' || status === 'aborted';

  const deleteFileMutation = trpc.modelFile.delete.useMutation({
    async onSuccess() {
      await queryUtils.modelVersion.getById.invalidate({ id: versionId });
      if (modelId) await queryUtils.model.getById.invalidate({ id: modelId });
    },
    onError() {
      showErrorNotification({
        error: new Error('Could not delete file, please try again'),
      });
    },
  });
  const handleRemoveFile = async (file: TrackedFile) => {
    if (file.id) await deleteFileMutation.mutateAsync({ id: file.id });
    clear((item) => item.uuid === file.uuid);
  };

  const filterByFileExtension = (value: ModelFileType) => {
    const extension = getFileExtension(file.name);

    switch (extension) {
      case 'ckpt':
      case 'safetensors':
        return ['Model', 'VAE'].includes(value);
      case 'pt':
        return ['Model', 'Negative', 'Text Encoder', 'VAE'].includes(value);
      case 'zip':
        return ['Training Data', 'Archive'].includes(value);
      case 'yml':
      case 'yaml':
        return ['Config'].includes(value);
      case 'bin':
        return ['Model', 'Negative'].includes(value);
      default:
        return true;
    }
  };

  return (
    <Card sx={{ opacity: deleteFileMutation.isLoading ? 0.2 : undefined }} withBorder>
      <Stack spacing={4} pb="xs">
        <Group position="apart" spacing={4} noWrap>
          <Text
            lineClamp={1}
            color={failedUpload ? 'red' : undefined}
            sx={{ display: 'inline-block' }}
          >
            {name}
          </Text>
          {status === 'uploading' && (
            <Tooltip label="Cancel upload" position="left">
              <ActionIcon color="red" onClick={() => abort(uuid)}>
                <IconX />
              </ActionIcon>
            </Tooltip>
          )}
          {(status === 'success' || status === 'pending') && (
            <Tooltip label="Remove file" position="left">
              <ActionIcon
                color="red"
                onClick={() => handleRemoveFile(file)}
                loading={deleteFileMutation.isLoading}
              >
                <IconTrash />
              </ActionIcon>
            </Tooltip>
          )}
          {failedUpload && (
            <Tooltip label="Retry upload" position="left">
              <ActionIcon color="blue" onClick={() => onRetry([file])}>
                <IconRefresh />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {['success', 'uploading'].includes(status) ? (
          <>
            <Stack spacing={0}>
              <Text size="sm" weight="bold">
                File Type
              </Text>
              <Text size="sm" color="dimmed">
                {type ?? 'undefined'}
              </Text>
            </Stack>
            {type === 'Model' ? (
              <>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Model size
                  </Text>
                  <Text size="sm" color="dimmed">
                    {size ?? 'undefined'}
                  </Text>
                </Stack>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Floating point
                  </Text>
                  <Text size="sm" color="dimmed">
                    {fp ?? 'undefined'}
                  </Text>
                </Stack>
              </>
            ) : null}
          </>
        ) : (
          <>
            <Select
              label="File Type"
              placeholder="Select a type"
              error={error?.type?._errors[0]}
              data={fileTypes.filter(filterByFileExtension)}
              value={type ?? null}
              onChange={(value: ModelFileType | null) => {
                updateMeta(file.uuid, (meta) => ({
                  ...meta,
                  type: value,
                  size: null,
                  fp: null,
                }));
              }}
              withAsterisk
              withinPortal
            />
            {type === 'Model' && (
              <>
                <Select
                  label="Model Size"
                  placeholder="Pruned or Full"
                  data={constants.modelFileSizes.map((size) => ({
                    label: startCase(size),
                    value: size,
                  }))}
                  error={error?.size?._errors[0]}
                  value={size ?? null}
                  onChange={(value: 'Full' | 'Pruned' | null) => {
                    updateMeta(file.uuid, (meta) => ({ ...meta, size: value }));
                  }}
                  withAsterisk
                  withinPortal
                />

                <Select
                  label="Floating Point"
                  placeholder="fp16 or fp32"
                  data={constants.modelFileFp}
                  error={error?.fp?._errors[0]}
                  value={fp ?? null}
                  onChange={(value: 'fp16' | 'fp32' | null) => {
                    updateMeta(file.uuid, (meta) => ({ ...meta, fp: value }));
                  }}
                  withAsterisk
                  withinPortal
                />
              </>
            )}
          </>
        )}
      </Stack>
      <Card.Section inheritPadding withBorder>
        <Group spacing="xs" py="md" sx={{ width: '100%' }}>
          {status === 'uploading' ? (
            <>
              <IconCloudUpload color={theme.colors.blue[theme.fn.primaryShade()]} />
              <Stack spacing={4} sx={{ flex: '1 !important' }}>
                <Progress
                  size="xl"
                  radius="xs"
                  value={progress}
                  label={`${Math.floor(progress)}%`}
                  color={progress < 100 ? 'blue' : 'green'}
                  striped
                  animate
                />
                <Group position="apart" noWrap>
                  <Text color="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
                  <Text color="dimmed" size="xs">{`${formatSeconds(
                    timeRemaining
                  )} remaining`}</Text>
                </Group>
              </Stack>
            </>
          ) : (
            mapStatusLabel[status]
          )}
        </Group>
      </Card.Section>
    </Card>
  );
}

type FileCardProps = {
  file: TrackedFile;
  fileTypes: ModelFileType[];
  onRetry: (files: TrackedFile[]) => void;
  modelId?: number;
  error?: SchemaError;
};
