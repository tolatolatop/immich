import { APP_UPLOAD_LOCATION } from '@app/common';
import { ImmichLogLevel } from '@app/common/constants/log-level.constant';
import { AssetEntity, AssetType } from '@app/database/entities/asset.entity';
import {
  WebpGeneratorProcessor,
  generateJPEGThumbnailProcessorName,
  generateWEBPThumbnailProcessorName,
  JpegGeneratorProcessor,
  QueueNameEnum,
  MachineLearningJobNameEnum,
} from '@app/job';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { mapAsset } from 'apps/immich/src/api-v1/asset/response-dto/asset-response.dto';
import { Job, Queue } from 'bull';
import ffmpeg from 'fluent-ffmpeg';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import sanitize from 'sanitize-filename';
import sharp from 'sharp';
import { Repository } from 'typeorm/repository/Repository';
import { join } from 'path';
import { CommunicationGateway } from 'apps/immich/src/api-v1/communication/communication.gateway';
import { IMachineLearningJob } from '@app/job/interfaces/machine-learning.interface';

@Processor(QueueNameEnum.THUMBNAIL_GENERATION)
export class ThumbnailGeneratorProcessor {
  private logLevel: ImmichLogLevel;

  constructor(
    @InjectRepository(AssetEntity)
    private assetRepository: Repository<AssetEntity>,

    @InjectQueue(QueueNameEnum.THUMBNAIL_GENERATION)
    private thumbnailGeneratorQueue: Queue,

    private wsCommunicationGateway: CommunicationGateway,

    @InjectQueue(QueueNameEnum.MACHINE_LEARNING)
    private machineLearningQueue: Queue<IMachineLearningJob>,

    private configService: ConfigService,
  ) {
    this.logLevel = this.configService.get('LOG_LEVEL') || ImmichLogLevel.SIMPLE;
  }

  @Process({ name: generateJPEGThumbnailProcessorName, concurrency: 3 })
  async generateJPEGThumbnail(job: Job<JpegGeneratorProcessor>) {
    const basePath = APP_UPLOAD_LOCATION;

    const { asset } = job.data;
    const sanitizedDeviceId = sanitize(String(asset.deviceId));

    const resizePath = join(basePath, asset.userId, 'thumb', sanitizedDeviceId);

    if (!existsSync(resizePath)) {
      mkdirSync(resizePath, { recursive: true });
    }

    const temp = asset.originalPath.split('/');
    const originalFilename = temp[temp.length - 1].split('.')[0];
    const jpegThumbnailPath = join(resizePath, `${originalFilename}.jpeg`);

    if (asset.type == AssetType.IMAGE) {
      try {
        await sharp(asset.originalPath).resize(1440, 2560, { fit: 'inside' }).jpeg().rotate().toFile(jpegThumbnailPath);
        await this.assetRepository.update({ id: asset.id }, { resizePath: jpegThumbnailPath });
      } catch (error) {
        Logger.error('Failed to generate jpeg thumbnail for asset: ' + asset.id);

        if (this.logLevel == ImmichLogLevel.VERBOSE) {
          console.trace('Failed to generate jpeg thumbnail for asset', error);
        }
      }

      // Update resize path to send to generate webp queue
      asset.resizePath = jpegThumbnailPath;

      await this.thumbnailGeneratorQueue.add(generateWEBPThumbnailProcessorName, { asset }, { jobId: randomUUID() });
      await this.machineLearningQueue.add(MachineLearningJobNameEnum.IMAGE_TAGGING, { asset }, { jobId: randomUUID() });
      await this.machineLearningQueue.add(
        MachineLearningJobNameEnum.OBJECT_DETECTION,
        { asset },
        { jobId: randomUUID() },
      );
      this.wsCommunicationGateway.server.to(asset.userId).emit('on_upload_success', JSON.stringify(mapAsset(asset)));
    }

    if (asset.type == AssetType.VIDEO) {
      await new Promise((resolve, reject) => {
        ffmpeg(asset.originalPath)
          .outputOptions(['-ss 00:00:00.000', '-frames:v 1'])
          .output(jpegThumbnailPath)
          .on('start', () => {
            Logger.log('Start Generating Video Thumbnail', 'generateJPEGThumbnail');
          })
          .on('error', (error) => {
            Logger.error(`Cannot Generate Video Thumbnail ${error}`, 'generateJPEGThumbnail');
            reject(error);
          })
          .on('end', async () => {
            Logger.log(`Generating Video Thumbnail Success ${asset.id}`, 'generateJPEGThumbnail');
            resolve(asset);
          })
          .run();
      });

      await this.assetRepository.update({ id: asset.id }, { resizePath: jpegThumbnailPath });

      // Update resize path to send to generate webp queue
      asset.resizePath = jpegThumbnailPath;

      await this.thumbnailGeneratorQueue.add(generateWEBPThumbnailProcessorName, { asset }, { jobId: randomUUID() });
      await this.machineLearningQueue.add(MachineLearningJobNameEnum.IMAGE_TAGGING, { asset }, { jobId: randomUUID() });
      await this.machineLearningQueue.add(
        MachineLearningJobNameEnum.OBJECT_DETECTION,
        { asset },
        { jobId: randomUUID() },
      );

      this.wsCommunicationGateway.server.to(asset.userId).emit('on_upload_success', JSON.stringify(mapAsset(asset)));
    }
  }

  @Process({ name: generateWEBPThumbnailProcessorName, concurrency: 3 })
  async generateWepbThumbnail(job: Job<WebpGeneratorProcessor>) {
    const { asset } = job.data;

    if (!asset.resizePath) {
      return;
    }

    const webpPath = asset.resizePath.replace('jpeg', 'webp');

    try {
      await sharp(asset.resizePath).resize(250).webp().rotate().toFile(webpPath);
      await this.assetRepository.update({ id: asset.id }, { webpPath: webpPath });
    } catch (error) {
      Logger.error('Failed to generate webp thumbnail for asset: ' + asset.id);

      if (this.logLevel == ImmichLogLevel.VERBOSE) {
        console.trace('Failed to generate webp thumbnail for asset', error);
      }
    }
  }
}
