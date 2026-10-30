import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators/auth.decorators';
import { UploadFileDto } from './dto/upload.dto';
import { FILE_PURPOSES, FilesService } from './files.service';

const MAX = Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024;

@ApiTags('Файлы')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: [...FILE_PURPOSES] },
        entityType: { type: 'string' },
        entityId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX, files: 1 } }))
  @ApiOperation({ summary: 'Загрузить файл (фото, вложение, импорт)' })
  async upload(@UploadedFile() file: Express.Multer.File, @Body() dto: UploadFileDto) {
    const f = await this.files.save(file, dto);
    const { storagePath: _p, ...view } = f;
    return view;
  }

  @Get(':id/meta')
  @ApiBearerAuth()
  async meta(@Param('id', ParseUUIDPipe) id: string) {
    const { storagePath: _p, ...view } = await this.files.meta(id);
    return view;
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Скачать файл (только с токеном своего магазина)' })
  async download(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    return this.send(await this.files.open(id), res);
  }

  @Post(':id/link')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Временная ссылка на 10 минут (для <img src>)' })
  link(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.signedLink(id);
  }

  @Public()
  @Get('public/:token')
  @ApiOperation({ summary: 'Открыть файл по временной ссылке' })
  async byLink(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const { fid, tid } = this.files.verifyLink(token);
    return this.send(await this.files.open(fid, tid), res);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.files.remove(id);
  }

  private send({ file, stream }: Awaited<ReturnType<FilesService['open']>>, res: Response) {
    const inline = file.mime.startsWith('image/') || file.mime === 'application/pdf';
    res.set({
      'Content-Type': file.mime,
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    });
    return new StreamableFile(stream);
  }
}
