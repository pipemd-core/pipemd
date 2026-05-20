#include "engine.h"
#include <spdlog/spdlog.h>
#include <fmt/format.h>
#include <iostream>

void DieselEngine::start() { rpm_ = 800; spdlog::info("Diesel started"); }
void DieselEngine::stop() { rpm_ = 0; }
std::string DieselEngine::status() const { return fmt::format("rpm={}", rpm_); }
int DieselEngine::getRpm() const { return rpm_; }
void DieselEngine::setFuelType(const std::string& type) { fuelType_ = type; }

void ElectricMotor::start() { voltage_ = 400.0; }
void ElectricMotor::stop() { voltage_ = 0.0; }
std::string ElectricMotor::status() const { return fmt::format("voltage={}", voltage_); }
double ElectricMotor::getVoltage() const { return voltage_; }
void ElectricMotor::setVoltage(double v) { voltage_ = v; }