import { Controller, Get, Post, Put, Delete, Patch, Body, Param } from '@nestjs/common';

@Controller('/users')
export class UsersController {
  @Get()
  findAll() {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Get('/profile')
  getProfile() {
    return {};
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }

  @Post('/batch')
  createBatch(@Body() body: unknown) {
    return body;
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return { id, ...body };
  }

  @Patch(':id')
  partialUpdate(@Param('id') id: string, @Body() body: unknown) {
    return { id, ...body };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: id };
  }
}