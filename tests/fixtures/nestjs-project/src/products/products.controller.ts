import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';

@Controller('/products')
export class ProductsController {
  @Get()
  findAll() {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Get('/featured')
  findFeatured() {
    return [];
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return { id, ...body };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: id };
  }
}