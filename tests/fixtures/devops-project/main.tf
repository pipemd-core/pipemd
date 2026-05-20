resource "aws_s3_bucket" "app_data" {
  bucket = "app-data-bucket"
}

resource "aws_s3_bucket_versioning" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  versioning_configuration {
    status = "Enabled"
  }
}

module "network" {
  source = "./modules/network"
  vpc_cidr = "10.0.0.0/16"
}

module "database" {
  source = "./modules/database"
  subnet_ids = module.network.private_subnet_ids
}