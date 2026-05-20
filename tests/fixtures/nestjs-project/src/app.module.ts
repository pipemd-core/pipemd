import { Module } from '@nestjs/common';
import { UsersController } from './users/users.controller';
import { ProductsController } from './products/products.controller';

@Module({
  controllers: [UsersController, ProductsController],
})
export class AppModule {}