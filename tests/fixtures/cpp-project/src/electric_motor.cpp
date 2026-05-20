#include "engine.h"
void ElectricMotor::start() { voltage_ = 400.0; }
void ElectricMotor::stop() { voltage_ = 0.0; }