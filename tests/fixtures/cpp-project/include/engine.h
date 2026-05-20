#pragma once
#include <string>
#include <vector>
#include <memory>

class Engine {
public:
    virtual ~Engine() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual std::string status() const = 0;
};

class DieselEngine : public Engine {
public:
    void start() override;
    void stop() override;
    std::string status() const override;
    int getRpm() const;
    void setFuelType(const std::string& type);
private:
    int rpm_ = 0;
    std::string fuelType_;
};

class ElectricMotor : public Engine {
public:
    void start() override;
    void stop() override;
    std::string status() const override;
    double getVoltage() const;
    void setVoltage(double v);
private:
    double voltage_ = 0.0;
};