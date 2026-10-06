import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { mongo, Error as MongooseError } from 'mongoose';

/**
 * Traduce errores de Mongo/Mongoose que se escapen de los services a respuestas HTTP
 * comprensibles, sin filtrar detalles internos (stack traces, nombres de índices…).
 */
@Catch(
  mongo.MongoServerError,
  MongooseError.ValidationError,
  MongooseError.CastError,
)
export class MongoExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MongoExceptionFilter.name);

  catch(exception: Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (
      exception instanceof mongo.MongoServerError &&
      exception.code === 11000
    ) {
      return res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'El registro ya existe (valor duplicado).',
      });
    }
    if (
      exception instanceof MongooseError.ValidationError ||
      exception instanceof MongooseError.CastError
    ) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: exception.message,
      });
    }

    this.logger.error(exception.message, exception.stack);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Error interno del servidor.',
    });
  }
}
